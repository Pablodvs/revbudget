import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import { IngestStatus, MetaSchema } from 'shared';
import { app } from '../app';
import { config } from '../config';
import { db } from '../db';
import { parseFailures, transactions } from '../db/schema';
import { DEMO_EMAIL, DEMO_PASSWORD, DEMO_SAMPLES, seedDemo } from '../db/seed-demo';
import { stopRateLimitSweeper } from '../middleware/rate-limit';
import { invalidateContainsCache } from '../services/classifier';
import { ingestNotification } from '../services/ingest';
import * as telegram from '../services/telegram';
import { ensureMigrated, truncateAll, truncateAuth } from '../test/db';

// A demo never has Telegram (config refuses it), but this suite's config has
// the preload's fake bot: keep it unreached.
spyOn(telegram, 'sendClassifyPrompt').mockResolvedValue(null);
spyOn(telegram, 'sendConfirmRulePrompt').mockResolvedValue(null);
spyOn(telegram, 'sendParseFailedPrompt').mockResolvedValue(null);
spyOn(telegram, 'sendConfirmation').mockResolvedValue(undefined);

beforeAll(() => {
  ensureMigrated();
});

afterAll(() => {
  stopRateLimitSweeper();
  mock.restore();
});

beforeEach(async () => {
  await truncateAll();
  await truncateAuth();
  invalidateContainsCache();
});

afterEach(() => {
  config.DEMO_MODE = false;
});

describe('GET /api/meta', () => {
  test('outside demo mode it publishes nothing', async () => {
    const res = await app.request('/api/meta');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ demo: false, demoLogin: null, resetsAt: null, samples: [] });
  });

  test('in demo mode it publishes the demo login and samples, without a session', async () => {
    config.DEMO_MODE = true;
    const res = await app.request('/api/meta');
    expect(res.status).toBe(200);
    const meta = MetaSchema.parse(await res.json());
    expect(meta.demo).toBe(true);
    expect(meta.demoLogin).toEqual({ email: DEMO_EMAIL, password: DEMO_PASSWORD });
    expect(meta.samples).toEqual(DEMO_SAMPLES);
    // The next nightly reset, within a day.
    const resetsIn = Date.parse(meta.resetsAt ?? '') - Date.now();
    expect(resetsIn > 0 && resetsIn <= 25 * 60 * 60 * 1000).toBe(true);
  });
});

describe('DEMO_SAMPLES', () => {
  test('cover every outcome', () => {
    expect(new Set(DEMO_SAMPLES.map((s) => s.expect))).toEqual(new Set(IngestStatus.options));
    expect(new Set(DEMO_SAMPLES.map((s) => s.id)).size).toBe(DEMO_SAMPLES.length);
  });

  test.each(DEMO_SAMPLES.map((s) => [s.id, s] as const))(
    '%s lands where it says on a freshly seeded demo',
    async (_id, sample) => {
      await seedDemo();
      invalidateContainsCache();

      const result = await ingestNotification(sample.text, new Date(), 'test');
      expect(result.status).toBe(sample.expect);
      if (sample.expect === 'parse_failed') {
        expect(result.transactionId).toBeNull();
        expect((await db.select().from(parseFailures)).map((p) => p.rawText)).toEqual([
          sample.text,
        ]);
      } else {
        const stored = (await db.select().from(transactions)).find(
          (t) => t.id === result.transactionId,
        );
        expect(stored?.status).toBe(sample.expect);
        expect(stored?.rawText).toBe(sample.text);
      }
    },
  );
});
