import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { config } from './config';
import { auth } from './lib/auth';
import { stopRateLimitSweeper } from './middleware/rate-limit';
import { ensureMigrated, truncateAuth } from './test/db';

const { app } = await import('./app');

beforeAll(() => {
  ensureMigrated();
});

afterAll(() => {
  stopRateLimitSweeper();
});

describe('unknown /api/* paths', () => {
  test('GET on an unknown API path returns JSON 404, not the SPA', async () => {
    const res = await app.request('/api/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe('not_found');
    expect(typeof body.requestId).toBe('string');
  });

  test('unsupported verb on /api/auth/* returns JSON 404', async () => {
    const res = await app.request('/api/auth/whatever', { method: 'PUT' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });

  test('/api/health still resolves', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });
});

describe('Cache-Control on API responses', () => {
  test('app routes, better-auth routes and errors are all no-store', async () => {
    for (const path of ['/api/health', '/api/auth/get-session', '/api/nope', '/api/wallets']) {
      const res = await app.request(path);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });
});

describe('API body limit', () => {
  const signIn = (body: BodyInit, headers: Record<string, string> = {}) =>
    app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173', ...headers },
      body,
      duplex: 'half',
    } as RequestInit);
  const oversized = JSON.stringify({ email: 'a@b.test', password: 'x'.repeat(1024 * 1024) });

  async function expectPayloadTooLarge(res: Response) {
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe('payload_too_large');
    expect(typeof body.requestId).toBe('string');
  }

  test('rejects an oversized body before better-auth parses it', async () => {
    await expectPayloadTooLarge(
      await signIn(oversized, { 'Content-Length': String(oversized.length) }),
    );
  });

  test('rejects an oversized chunked body (no Content-Length)', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(16 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 64) controller.enqueue(chunk);
        else controller.close();
      },
    });
    await expectPayloadTooLarge(await signIn(stream));
  });

  test('lets a normal-sized body through', async () => {
    const body = JSON.stringify({ email: 'nobody@b.test', password: 'wrong-password-123' });
    const res = await signIn(body, { 'Content-Length': String(body.length) });
    expect(res.status).toBe(401);
  });
});

describe('demo auth lock', () => {
  const EMAIL = 'demo-lock@example.com';
  const PASSWORD = 'demo-lock-password-123';
  const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    app.request(`/api/auth/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const signIn = async () => {
    const res = await call('POST', 'sign-in/email', {}, { email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    return { Cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
  };

  beforeEach(async () => {
    await truncateAuth();
    await auth.api.createUser({
      body: { email: EMAIL, password: PASSWORD, name: 'Demo Lock', role: 'user' },
    });
    config.DEMO_MODE = true;
  });

  afterEach(() => {
    config.DEMO_MODE = false;
  });

  test('a visitor can sign in, read the session and sign out', async () => {
    const cookie = await signIn();
    const session = await call('GET', 'get-session', cookie);
    expect(((await session.json()) as { user: { email: string } }).user.email).toBe(EMAIL);
    expect((await call('POST', 'sign-out', cookie)).status).toBe(200);
    expect(await (await call('GET', 'get-session', cookie)).json()).toBeNull();
  });

  test.each([
    ['POST', 'change-password', { currentPassword: PASSWORD, newPassword: 'taken-over-123' }],
    ['POST', 'update-user', { name: 'Taken over' }],
    ['POST', 'change-email', { newEmail: 'taken@example.com' }],
    ['POST', 'delete-user', {}],
    ['POST', 'revoke-sessions', {}],
    ['GET', 'list-sessions', undefined],
    ['GET', 'admin/list-users', undefined],
    [
      'POST',
      'admin/create-user',
      { email: 'x@example.com', password: 'x-password-123', name: 'X' },
    ],
    ['POST', 'admin/set-role', { userId: 'x', role: 'admin' }],
    ['POST', 'sign-up/email', { email: 'x@example.com', password: 'x-password-123', name: 'X' }],
  ])('refuses %s %s, signed in or not', async (method, path, body) => {
    for (const headers of [await signIn(), {}]) {
      const res = await call(method, path, headers, body);
      expect(res.status).toBe(403);
      const json = (await res.json()) as { error: string; requestId: string };
      expect(json.error).toBe('demo_locked');
      expect(typeof json.requestId).toBe('string');
    }
  });

  // Bun hands the app the raw request line. Hono reads the path up to the first
  // '/', so this looks like get-session to it, while better-auth's URL parse
  // turns the backslashes into slashes and routes to list-sessions.
  test('an odd request line cannot smuggle a locked endpoint past the allowlist', async () => {
    const cookie = await signIn();
    const req = new Request('http://localhost/api/auth/get-session', {
      headers: { Origin: 'http://localhost:5173', ...cookie },
    });
    Object.defineProperty(req, 'url', {
      value: 'http://localhost\\api\\auth\\list-sessions?/api/auth/get-session',
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('demo_locked');
  });

  test('a refused change-password leaves the published password working', async () => {
    const body = { currentPassword: PASSWORD, newPassword: 'taken-over-123' };
    expect((await call('POST', 'change-password', await signIn(), body)).status).toBe(403);
    await signIn();
  });

  test('outside demo mode the same endpoints reach better-auth', async () => {
    config.DEMO_MODE = false;
    const cookie = await signIn();
    const res = await call('POST', 'update-user', cookie, { name: 'Renamed' });
    expect(res.status).toBe(200);
  });
});
