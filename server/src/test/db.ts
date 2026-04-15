import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { db } from '../db';
import { budgetPeriods, merchantRules, parseFailures, transactions, wallets } from '../db/schema';

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
  await db.delete(budgetPeriods);
  await db.delete(wallets);
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
