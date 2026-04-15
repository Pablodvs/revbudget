import { afterAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { rateLimit, stopRateLimitSweeper } from './rate-limit';

afterAll(() => {
  stopRateLimitSweeper();
});

function build(capacity: number, refillPerSecond: number) {
  const app = new Hono<{ Variables: { requestId: string } }>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'test-rid');
    await next();
  });
  app.use(
    '*',
    rateLimit({
      capacity,
      refillPerSecond,
      keyFn: (c) => c.req.header('x-test-ip') ?? 'unknown',
    }),
  );
  app.get('/', (c) => c.json({ ok: true }));
  return app;
}

describe('rateLimit middleware', () => {
  test('allows up to capacity then 429s', async () => {
    const app = build(3, 0);
    for (let i = 0; i < 3; i++) {
      const res = await app.request('/', { headers: { 'x-test-ip': '1.1.1.1' } });
      expect(res.status).toBe(200);
    }
    const blocked = await app.request('/', { headers: { 'x-test-ip': '1.1.1.1' } });
    expect(blocked.status).toBe(429);
  });

  test('separate keys have independent buckets', async () => {
    const app = build(1, 0);
    const a = await app.request('/', { headers: { 'x-test-ip': '2.2.2.2' } });
    const b = await app.request('/', { headers: { 'x-test-ip': '3.3.3.3' } });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const blockedA = await app.request('/', { headers: { 'x-test-ip': '2.2.2.2' } });
    expect(blockedA.status).toBe(429);
  });

  test('refill restores capacity over time', async () => {
    const app = build(1, 10); // 10 tokens/sec = 100ms per token
    const first = await app.request('/', { headers: { 'x-test-ip': '4.4.4.4' } });
    expect(first.status).toBe(200);
    const blocked = await app.request('/', { headers: { 'x-test-ip': '4.4.4.4' } });
    expect(blocked.status).toBe(429);
    await Bun.sleep(150);
    const after = await app.request('/', { headers: { 'x-test-ip': '4.4.4.4' } });
    expect(after.status).toBe(200);
  });

  test('returns requestId in 429 body', async () => {
    const app = build(0, 0);
    const res = await app.request('/', { headers: { 'x-test-ip': '5.5.5.5' } });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe('rate_limited');
    expect(body.requestId).toBe('test-rid');
  });
});
