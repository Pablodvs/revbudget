import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';

export const MIGRATIONS_FOLDER = resolve(import.meta.dir, 'migrations');

// drizzle applies all pending migrations inside one BEGIN…COMMIT, where SQLite
// ignores `PRAGMA foreign_keys`. The OFF/ON pair drizzle-kit writes around a table
// rebuild is therefore a no-op, and the rebuild's DROP TABLE fires ON DELETE
// actions (0003 nulled every related_tx_id this way). Switch enforcement off
// outside the transaction, and check integrity before switching it back on.
export function runMigrations<TSchema extends Record<string, unknown>>(
  db: BunSQLiteDatabase<TSchema>,
  migrationsFolder = MIGRATIONS_FOLDER,
): void {
  db.run(sql`PRAGMA foreign_keys = OFF`);
  try {
    migrate(db, { migrationsFolder });
    const violations = db.all(sql`PRAGMA foreign_key_check`);
    if (violations.length > 0) {
      throw new Error(`foreign key violations after migrating: ${JSON.stringify(violations)}`);
    }
  } finally {
    db.run(sql`PRAGMA foreign_keys = ON`);
  }
}

if (import.meta.main) {
  // Imported lazily so loading runMigrations doesn't open the app database.
  const { db } = await import('./index');
  try {
    runMigrations(db);
    console.log('[migrate] done');
  } catch (err) {
    console.error('[migrate] failed:', err);
    process.exit(1);
  }
}
