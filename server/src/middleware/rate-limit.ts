import type { MiddlewareHandler } from 'hono';
import { log } from '../lib/log';

type Bucket = { tokens: number; updatedAt: number };

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const IDLE_EVICT_MS = 10 * 60 * 1000;
const HARD_CAP = 10_000;

type RegisteredStore = {
  buckets: Map<string, Bucket>;
  capacity: number;
};

const stores: RegisteredStore[] = [];

function sweep(now: number): void {
  for (const store of stores) {
    for (const [key, bucket] of store.buckets) {
      if (bucket.tokens >= store.capacity && now - bucket.updatedAt >= IDLE_EVICT_MS) {
        store.buckets.delete(key);
      }
    }
  }
}

const sweeper = setInterval(() => sweep(Date.now()), SWEEP_INTERVAL_MS);
sweeper.unref?.();

export function stopRateLimitSweeper(): void {
  clearInterval(sweeper);
}

export function rateLimit(options: {
  capacity: number;
  refillPerSecond: number;
  keyFn?: (c: Parameters<MiddlewareHandler>[0]) => string;
}): MiddlewareHandler {
  const buckets = new Map<string, Bucket>();
  stores.push({ buckets, capacity: options.capacity });
  const keyFn = options.keyFn ?? (() => 'global');
  return async (c, next) => {
    const key = keyFn(c);
    const now = Date.now();
    const existing = buckets.get(key);
    const bucket: Bucket = existing ?? { tokens: options.capacity, updatedAt: now };
    const elapsed = (now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(options.capacity, bucket.tokens + elapsed * options.refillPerSecond);
    bucket.updatedAt = now;

    if (!existing && buckets.size >= HARD_CAP) {
      sweep(now);
      if (buckets.size >= HARD_CAP) {
        log.warn(c.get('requestId') ?? 'unknown', 'rate_limit_saturated', {
          size: buckets.size,
          key,
        });
        return c.json({ error: 'rate_limited', requestId: c.get('requestId') ?? '' }, 429);
      }
    }

    if (bucket.tokens < 1) {
      buckets.set(key, bucket);
      return c.json({ error: 'rate_limited', requestId: c.get('requestId') ?? '' }, 429);
    }
    bucket.tokens -= 1;
    buckets.set(key, bucket);
    await next();
  };
}
