import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { authedHeaders, ensureMigrated } from '../test/db';
import { stopRateLimitSweeper } from './rate-limit';
import { requireSession } from './require-session';

function build() {
  const app = new Hono<{
    Variables: { requestId: string; user?: unknown; session?: unknown };
  }>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'test-rid');
    await next();
  });
  app.use('*', requireSession);
  app.get('/', (c) =>
    c.json({ ok: true, email: (c.get('user') as { email?: string } | undefined)?.email }),
  );
  return app;
}

beforeAll(() => {
  ensureMigrated();
});

afterAll(() => {
  stopRateLimitSweeper();
});

describe('requireSession', () => {
  test('200 with valid session cookie', async () => {
    const headers = await authedHeaders();
    const res = await build().request('/', { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; email: string };
    expect(body.ok).toBe(true);
    expect(body.email).toBe('test-fixture@example.com');
  });

  test('401 with no cookie', async () => {
    const res = await build().request('/');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe('unauthorized');
    expect(body.requestId).toBe('test-rid');
  });

  test('401 with malformed cookie', async () => {
    const res = await build().request('/', {
      headers: { Cookie: 'better-auth.session_token=not-a-real-token' },
    });
    expect(res.status).toBe(401);
  });
});
