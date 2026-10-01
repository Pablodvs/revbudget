import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { stopRateLimitSweeper } from './middleware/rate-limit';
import { ensureMigrated } from './test/db';

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
