import { afterAll, afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { Hono } from 'hono';
import { HARD_CAP, IDLE_EVICT_MS, rateLimit, stopRateLimitSweeper } from './rate-limit';

afterAll(() => {
  stopRateLimitSweeper();
});

afterEach(() => {
  setSystemTime();
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

describe('rateLimit eviction', () => {
  const t0 = new Date('2026-01-01T00:00:00Z').getTime();
  const hit = (app: ReturnType<typeof build>, ip: string) =>
    app.request('/', { headers: { 'x-test-ip': ip } });

  async function flood(app: ReturnType<typeof build>, count: number) {
    for (let i = 0; i < count; i++) {
      expect((await hit(app, `flood-${i}`)).status).toBe(200);
    }
  }

  test('a saturated store admits a new key by evicting the least recently used one', async () => {
    setSystemTime(t0);
    const app = build(1, 0);
    await flood(app, HARD_CAP); // flood-0 is now the least recently used
    expect((await hit(app, 'flood-0')).status).toBe(429); // ...and now flood-1 is

    expect((await hit(app, 'phone')).status).toBe(200);
    expect((await hit(app, 'phone')).status).toBe(429); // tracked like any other key
    // The store stayed at HARD_CAP: flood-1 was forgotten (a fresh bucket admits
    // it again), while flood-0, touched since, is still drained.
    expect((await hit(app, 'flood-1')).status).toBe(200);
    expect((await hit(app, 'flood-0')).status).toBe(429);
  });

  test('evicts only idle buckets, so an active one keeps its drained state', async () => {
    setSystemTime(t0);
    const app = build(1, 0);
    expect((await hit(app, 'hot')).status).toBe(200);
    await flood(app, HARD_CAP - 1);

    setSystemTime(t0 + IDLE_EVICT_MS - 1);
    expect((await hit(app, 'hot')).status).toBe(429);

    // The newcomer triggers the at-cap sweep: the idle flood goes, 'hot' stays.
    setSystemTime(t0 + IDLE_EVICT_MS);
    expect((await hit(app, 'newcomer')).status).toBe(200);
    expect((await hit(app, 'hot')).status).toBe(429);
  });
});
