import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { apiAuth } from './api-auth';

const TOKEN = 'test_api_token_must_be_at_least_32_chars_long';

function build() {
  const app = new Hono<{ Variables: { requestId: string } }>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'test-rid');
    await next();
  });
  app.use('*', apiAuth);
  app.get('/', (c) => c.json({ ok: true }));
  return app;
}

describe('apiAuth', () => {
  test('200 with valid bearer token', async () => {
    const res = await build().request('/', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  test('401 with missing Authorization header', async () => {
    const res = await build().request('/');
    expect(res.status).toBe(401);
  });

  test('401 with non-Bearer scheme', async () => {
    const res = await build().request('/', {
      headers: { Authorization: `Basic ${TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  test('401 with wrong token of same length', async () => {
    const wrong = 'x'.repeat(TOKEN.length);
    const res = await build().request('/', {
      headers: { Authorization: `Bearer ${wrong}` },
    });
    expect(res.status).toBe(401);
  });

  test('401 with wrong-length token', async () => {
    const res = await build().request('/', {
      headers: { Authorization: 'Bearer short' },
    });
    expect(res.status).toBe(401);
  });

  test('401 response includes requestId', async () => {
    const res = await build().request('/');
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe('unauthorized');
    expect(body.requestId).toBe('test-rid');
  });
});
