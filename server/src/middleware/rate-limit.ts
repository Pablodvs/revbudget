import type { MiddlewareHandler } from 'hono';
import { log } from '../lib/log';

type Bucket = { tokens: number; updatedAt: number };

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
export const IDLE_EVICT_MS = 10 * 60 * 1000;
export const HARD_CAP = 10_000;

const stores: Map<string, Bucket>[] = [];

function sweep(now: number): void {
  for (const buckets of stores) {
    for (const [key, bucket] of buckets) {
      // Idle alone suffices: a bucket refills (capacity / refillPerSecond) well
      // within IDLE_EVICT_MS, so dropping it is the same as keeping a full one.
      if (now - bucket.updatedAt >= IDLE_EVICT_MS) {
        buckets.delete(key);
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
  stores.push(buckets);
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
        // Evict the least recently used bucket rather than turn the newcomer
        // away: a flood of fresh keys (one IPv6 /48 holds 65,536 /64s) must not
        // lock out a real client whose bucket went idle and was swept.
        const lru = buckets.keys().next().value;
        if (lru !== undefined) buckets.delete(lru);
      }
    }

    // Delete + set moves the key to the end, so Map order is least recently used first.
    buckets.delete(key);
    buckets.set(key, bucket);
    if (bucket.tokens < 1) {
      return c.json({ error: 'rate_limited', requestId: c.get('requestId') ?? '' }, 429);
    }
    bucket.tokens -= 1;
    await next();
  };
}
