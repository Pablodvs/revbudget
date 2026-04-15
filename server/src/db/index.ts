import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { config } from '../config';
import * as schema from './schema';

const dbPath = resolve(process.cwd(), config.DATABASE_URL);
mkdirSync(dirname(dbPath), { recursive: true });

const sqlite = new Database(dbPath, { create: true });
sqlite.exec('PRAGMA journal_mode = WAL;');
sqlite.exec('PRAGMA foreign_keys = ON;');
sqlite.exec('PRAGMA busy_timeout = 5000;');

export const db = drizzle(sqlite, { schema });
export { schema };

export function runPragmas() {
  db.run(sql`PRAGMA journal_mode = WAL`);
  db.run(sql`PRAGMA foreign_keys = ON`);
}
