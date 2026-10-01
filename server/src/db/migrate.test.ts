import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { MIGRATIONS_FOLDER, runMigrations } from './migrate';

type JournalEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};

let dir: string;
let folder: string;
let sqlite: Database;

// Appends a migration to the scratch copy of the folder, as drizzle-kit would.
function addMigration(tag: string, statements: string[]): void {
  writeFileSync(join(folder, `${tag}.sql`), statements.join('\n--> statement-breakpoint\n'));
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: JournalEntry[] };
  const when = (journal.entries.at(-1)?.when ?? 0) + 1;
  journal.entries.push({ idx: journal.entries.length, version: '6', when, tag, breakpoints: true });
  writeFileSync(journalPath, JSON.stringify(journal));
}

// The 12-step table rebuild drizzle-kit generates for an ALTER that SQLite can't
// do in place (e.g. migration 0003), derived from the live table definition.
function rebuild(table: string): string[] {
  const row = sqlite.query('SELECT sql FROM sqlite_master WHERE name = ?').get(table) as {
    sql: string;
  };
  const created = row.sql
    .replace(/^CREATE TABLE [`"]\w+[`"]/, `CREATE TABLE \`__new_${table}\``)
    .replaceAll(`"${table}".`, `"__new_${table}".`);
  return [
    'PRAGMA foreign_keys=OFF;',
    `${created};`,
    `INSERT INTO \`__new_${table}\` SELECT * FROM \`${table}\`;`,
    `DROP TABLE \`${table}\`;`,
    `ALTER TABLE \`__new_${table}\` RENAME TO \`${table}\`;`,
    'PRAGMA foreign_keys=ON;',
  ];
}

const foreignKeysOn = () =>
  (sqlite.query('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys === 1;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'revbudget-migrate-'));
  folder = join(dir, 'migrations');
  cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
  sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;'); // as db/index.ts opens the app connection
  runMigrations(drizzle(sqlite), folder);

  sqlite.exec(`INSERT INTO wallets (id, name, budget, color) VALUES (1, 'Food', 10000, '#22c55e')`);
  sqlite.exec(
    `INSERT INTO transactions (id, wallet_id, amount, merchant, merchant_display, raw_text, status, transaction_date, type)
     VALUES (1, 1, 500, 'shop', 'Shop', 'x', 'classified', '2026-01-01T00:00:00Z', 'expense')`,
  );
  sqlite.exec(
    `INSERT INTO transactions (id, wallet_id, amount, merchant, merchant_display, raw_text, status, transaction_date, type, related_tx_id)
     VALUES (2, 1, 200, 'shop', 'Shop', 'x', 'classified', '2026-01-02T00:00:00Z', 'refund', 1)`,
  );
  sqlite.exec(`INSERT INTO merchant_rules (pattern, wallet_id) VALUES ('shop', 1)`);
});

afterEach(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('runMigrations', () => {
  test('table rebuilds keep foreign-key links and dependent rows', () => {
    addMigration('9000_rebuild_transactions', rebuild('transactions'));
    addMigration('9001_rebuild_wallets', rebuild('wallets'));

    runMigrations(drizzle(sqlite), folder);

    expect(
      sqlite.query('SELECT id, wallet_id, related_tx_id FROM transactions ORDER BY id').all(),
    ).toEqual([
      { id: 1, wallet_id: 1, related_tx_id: null },
      { id: 2, wallet_id: 1, related_tx_id: 1 },
    ]);
    expect(sqlite.query('SELECT pattern, wallet_id FROM merchant_rules').all()).toEqual([
      { pattern: 'shop', wallet_id: 1 },
    ]);
    expect(foreignKeysOn()).toBe(true);
  });

  test('fails on dangling references and still re-enables enforcement', () => {
    addMigration('9000_orphan_rows', ['DELETE FROM wallets;']);

    expect(() => runMigrations(drizzle(sqlite), folder)).toThrow(/foreign key violations/);
    expect(foreignKeysOn()).toBe(true);
  });
});
