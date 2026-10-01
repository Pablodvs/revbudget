import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { db } from '../db';
import {
  account,
  merchantRules,
  parseFailures,
  session,
  transactions,
  user,
  verification,
  wallets,
} from '../db/schema';
import { auth } from '../lib/auth';

let migrated = false;

export function ensureMigrated(): void {
  if (migrated) return;
  const migrationsFolder = resolve(import.meta.dir, '..', 'db', 'migrations');
  migrate(db, { migrationsFolder });
  migrated = true;
}

export async function truncateAll(): Promise<void> {
  await db.delete(transactions);
  await db.delete(parseFailures);
  await db.delete(merchantRules);
  await db.delete(wallets);
}

export async function truncateAuth(): Promise<void> {
  await db.delete(session);
  await db.delete(account);
  await db.delete(verification);
  await db.delete(user);
  cachedCookie = null;
}

export async function seedWallet(
  overrides: Partial<typeof wallets.$inferInsert> = {},
): Promise<typeof wallets.$inferSelect> {
  const [row] = await db
    .insert(wallets)
    .values({
      name: overrides.name ?? 'Food',
      budget: overrides.budget ?? 35000,
      currency: overrides.currency ?? 'EUR',
      color: overrides.color ?? '#22c55e',
      icon: overrides.icon ?? '🍕',
      isActive: overrides.isActive ?? true,
    })
    .returning();
  if (!row) throw new Error('seedWallet: no row returned');
  return row;
}

const TEST_USER_EMAIL = 'test-fixture@example.com';
const TEST_USER_PASSWORD = 'fixture-password-1234';
let cachedCookie: string | null = null;

async function ensureTestUser(): Promise<void> {
  const existing = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, TEST_USER_EMAIL))
    .limit(1);
  if (existing.length > 0) return;
  await auth.api.createUser({
    body: {
      email: TEST_USER_EMAIL,
      password: TEST_USER_PASSWORD,
      name: 'Test Fixture',
      role: 'admin',
    },
  });
}

export async function authedHeaders(): Promise<Record<string, string>> {
  if (cachedCookie) return { Cookie: cachedCookie, 'Content-Type': 'application/json' };

  await ensureTestUser();
  const res = await auth.api.signInEmail({
    body: { email: TEST_USER_EMAIL, password: TEST_USER_PASSWORD },
    asResponse: true,
  });
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('authedHeaders: signInEmail returned no Set-Cookie');
  const firstPair = setCookie.split(';')[0]?.trim();
  if (!firstPair) throw new Error('authedHeaders: malformed Set-Cookie');
  cachedCookie = firstPair;
  return { Cookie: cachedCookie, 'Content-Type': 'application/json' };
}
