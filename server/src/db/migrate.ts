import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { db } from './index';

const migrationsFolder = resolve(import.meta.dir, 'migrations');

try {
  migrate(db, { migrationsFolder });
  console.log('[migrate] done');
} catch (err) {
  console.error('[migrate] failed:', err);
  process.exit(1);
}
