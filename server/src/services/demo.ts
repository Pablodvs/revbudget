import { count, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { config } from '../config';
import { db } from '../db';
import { merchantRules, parseFailures, session, transactions, user, wallets } from '../db/schema';
import {
  DEMO_EMAIL,
  DEMO_PASSWORD,
  insertDemoData,
  insertDemoUser,
  seedDemo,
} from '../db/seed-demo';
import { auth } from '../lib/auth';
import { log } from '../lib/log';
import { invalidateContainsCache } from './classifier';

// The demo account marks a demo database: in DEMO_MODE, only seeding an empty
// database creates it (here, or the CLI seed, which refuses a non-empty one).
function findDemoUser(t: Pick<typeof db, 'select'> = db) {
  return t.select({ id: user.id }).from(user).where(eq(user.email, DEMO_EMAIL)).get();
}

// DEMO_MODE on a real database, by mistake. The server refuses to run: the
// demo's write caps, auth lock and resets must never touch real data.
export class NotADemoDatabaseError extends Error {
  constructor() {
    super(`DEMO_MODE is on, but this database has transactions and no ${DEMO_EMAIL} user`);
  }
}

// Boot in demo mode: a database without transactions gets the demo data (the
// Docker entrypoint's default wallets are topped up, not duplicated). A
// restart keeps whatever visitors have done since.
export async function seedDemoIfEmpty(): Promise<void> {
  const [txCount] = await db.select({ n: count() }).from(transactions);
  if (txCount && txCount.n > 0) {
    if (!findDemoUser()) throw new NotADemoDatabaseError();
    return;
  }
  const report = await seedDemo();
  // A request during boot may have cached the rules before the seed's arrived.
  invalidateContainsCache();
  log.info('boot', 'demo_seeded', { report });
}

// Back to a freshly seeded demo: visitors' data and sessions go, and the demo
// account is recreated as published, so a changed password, name, role or ban
// doesn't outlive the night. Other users stay. One synchronous transaction,
// since drizzle's bun-sqlite transactions can't await (the password is hashed
// before it): a failed reseed keeps the old demo.
// Only on a demo database: DEMO_MODE set on a real one by mistake must never
// wipe it, so without the demo account nothing is deleted.
export async function resetDemo(now = new Date()): Promise<void> {
  const passwordHash = await (await auth.$context).password.hash(DEMO_PASSWORD);
  const report = db.transaction((t) => {
    const demoUser = findDemoUser(t);
    if (!demoUser) return null;
    t.delete(transactions).run();
    t.delete(parseFailures).run();
    t.delete(merchantRules).run();
    t.delete(wallets).run();
    t.delete(session).run();
    // Its credential account goes with it (ON DELETE CASCADE).
    t.delete(user).where(eq(user.id, demoUser.id)).run();
    insertDemoUser(t, passwordHash);
    return insertDemoData(t, now);
  });
  if (!report) {
    log.error('demo', 'demo_reset_refused', {
      reason: `no ${DEMO_EMAIL} user: not a demo database`,
    });
    return;
  }
  invalidateContainsCache();
  log.info('demo', 'demo_reset', { report });
}

// Where a demo's tables stop growing, however many visitors write to them: the
// write rate limit (app.ts) holds back one visitor, not many. The seed makes
// ~170 transactions, 7 wallets and 5 rules.
export const DEMO_CAPS = {
  transactions: 2000,
  parseFailures: 500,
  wallets: 30,
  merchantRules: 100,
};

const cappedTables = { transactions, parseFailures, wallets, merchantRules };

// Whether a demo's table is at its cap. Never outside demo mode.
export function demoFull(table: keyof typeof DEMO_CAPS): boolean {
  if (!config.DEMO_MODE) return false;
  const row = db.select({ n: count() }).from(cappedTables[table]).get();
  return (row?.n ?? 0) >= DEMO_CAPS[table];
}

// Refuses a new row in a full demo table: 403 demo_full.
export function assertDemoRoom(table: keyof typeof DEMO_CAPS): void {
  if (demoFull(table)) throw new HTTPException(403, { message: 'demo_full' });
}

const DAY_MS = 24 * 60 * 60 * 1000;

const wallClockFormats = new Map<string, Intl.DateTimeFormat>();

// The instant's wall-clock time in tz, read as if it were UTC.
function wallClock(at: Date, tz: string): number {
  let format = wallClockFormats.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    wallClockFormats.set(tz, format);
  }
  const part: Record<string, number> = {};
  for (const p of format.formatToParts(at)) part[p.type] = Number(p.value);
  return Date.UTC(
    part.year ?? 1970,
    (part.month ?? 1) - 1,
    part.day ?? 1,
    part.hour ?? 0,
    part.minute ?? 0,
    part.second ?? 0,
    at.getUTCMilliseconds(),
  );
}

// The first midnight in tz after `now`, when the dashboard's month rolls over:
// a reset on the 1st seeds the new month. Found on the wall clock, then
// converted with the UTC offset at that time rather than now's, so a DST
// change in between doesn't move it by an hour.
export function nextResetAt(now: Date, tz: string = config.APP_TIMEZONE): Date {
  const local = wallClock(now, tz);
  const today = new Date(local);
  let target = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (target <= local) target += DAY_MS;
  const guess = target - (local - now.getTime());
  const at = target - (wallClock(new Date(guess), tz) - guess);
  // Where DST skips midnight (Santiago, Beirut...), that lands on the hour
  // before, in the old day: the new day starts when the clocks jump instead.
  return new Date(at + Math.max(0, target - wallClock(new Date(at), tz)));
}

// In-process, and unref'd so it never keeps the process alive. Both the reseed
// and the next run count from the planned time: a timer firing a little early
// must not seed the day (and month) that is ending, or land on the same
// midnight again.
export function scheduleDemoReset(from = new Date()): void {
  const at = nextResetAt(from);
  log.info('demo', 'demo_reset_scheduled', { at: at.toISOString() });
  const timer = setTimeout(() => {
    const now = new Date(Math.max(Date.now(), at.getTime()));
    resetDemo(now)
      .catch((err: unknown) => {
        log.error('demo', 'demo_reset_failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      })
      .then(() => scheduleDemoReset(now));
  }, at.getTime() - Date.now());
  timer.unref?.();
}
