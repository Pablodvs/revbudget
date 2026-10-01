import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import {
  type TransactionRow,
  type WalletRow,
  merchantRules,
  transactions,
  wallets,
} from '../db/schema';

export type ClassifyResult = {
  walletId: number | null;
  wallet: WalletRow | null;
  ruleId: number | null;
  matchType: 'exact' | 'contains' | null;
  requireConfirmation: boolean;
};

type ContainsRule = {
  id: number;
  walletId: number;
  pattern: string;
  wallet: WalletRow;
  requireConfirmation: boolean;
};

// Module-level cache of `contains` rules (joined with wallet). Invalidated by
// the merchant-rules and wallets routes; the rule writes in this module only
// ever touch exact rules, which aren't cached. Assumes a single server process:
// concurrent webhook + rule-edit races can briefly serve stale contains rules,
// acceptable for this single-user app.
let containsCache: ContainsRule[] | null = null;

export function invalidateContainsCache(): void {
  containsCache = null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function loadContainsRules(): Promise<ContainsRule[]> {
  if (containsCache) return containsCache;
  const rows = await db
    .select({
      id: merchantRules.id,
      walletId: merchantRules.walletId,
      pattern: merchantRules.pattern,
      requireConfirmation: merchantRules.requireConfirmation,
      wallet: wallets,
    })
    .from(merchantRules)
    .innerJoin(wallets, eq(merchantRules.walletId, wallets.id))
    .where(eq(merchantRules.matchType, 'contains'));
  containsCache = rows;
  return rows;
}

export async function classifyMerchant(normalizedMerchant: string): Promise<ClassifyResult> {
  if (!normalizedMerchant) {
    return {
      walletId: null,
      wallet: null,
      ruleId: null,
      matchType: null,
      requireConfirmation: false,
    };
  }
  const exact = await db
    .select({
      id: merchantRules.id,
      walletId: merchantRules.walletId,
      requireConfirmation: merchantRules.requireConfirmation,
      wallet: wallets,
    })
    .from(merchantRules)
    .innerJoin(wallets, eq(merchantRules.walletId, wallets.id))
    .where(and(eq(merchantRules.pattern, normalizedMerchant), eq(merchantRules.matchType, 'exact')))
    .limit(1);
  const first = exact[0];
  if (first) {
    return {
      walletId: first.walletId,
      wallet: first.wallet,
      ruleId: first.id,
      matchType: 'exact',
      requireConfirmation: first.requireConfirmation,
    };
  }
  const contains = await loadContainsRules();
  for (const rule of contains) {
    const re = new RegExp(`(?:^|\\W)${escapeRegex(rule.pattern)}(?:\\W|$)`);
    if (re.test(normalizedMerchant)) {
      return {
        walletId: rule.walletId,
        wallet: rule.wallet,
        ruleId: rule.id,
        matchType: 'contains',
        requireConfirmation: rule.requireConfirmation,
      };
    }
  }
  return {
    walletId: null,
    wallet: null,
    ruleId: null,
    matchType: null,
    requireConfirmation: false,
  };
}

// The db or a transaction handle, so rule writes can join the caller's transaction.
type Executor = Pick<typeof db, 'insert' | 'update' | 'delete'>;

// A pattern already owned by a contains rule is left alone (setWhere): the user
// wrote that rule, and one manual reclassification must not narrow it to exact.
// A new rule is stamped createdAt = now, so deleteExactRule can later tell the
// rule a classification created from one that already existed.
export function upsertExactRule(
  pattern: string,
  walletId: number,
  executor: Executor = db,
  now = new Date().toISOString(),
): void {
  executor
    .insert(merchantRules)
    .values({ pattern, walletId, matchType: 'exact', requireConfirmation: false, createdAt: now })
    .onConflictDoUpdate({
      target: merchantRules.pattern,
      set: { walletId, updatedAt: now },
      setWhere: eq(merchantRules.matchType, 'exact'),
    })
    .run();
}

// Forgets only the exact rule created at `createdAt` (see upsertExactRule).
// Contains rules are the user's, and an older exact rule belongs to the user or
// to another classification.
export function deleteExactRule(pattern: string, createdAt: string, executor: Executor = db): void {
  executor
    .delete(merchantRules)
    .where(
      and(
        eq(merchantRules.pattern, pattern),
        eq(merchantRules.matchType, 'exact'),
        eq(merchantRules.createdAt, createdAt),
      ),
    )
    .run();
}

// Only expenses teach rules: a refund or income from a merchant says nothing
// about which budget that merchant's spending belongs to.
const teachesRule = (tx: Pick<TransactionRow, 'merchant' | 'type'>) =>
  tx.type === 'expense' && tx.merchant !== '';

export function learnRule(
  tx: Pick<TransactionRow, 'merchant' | 'type'>,
  walletId: number,
  executor: Executor = db,
  now?: string,
): void {
  if (teachesRule(tx)) upsertExactRule(tx.merchant, walletId, executor, now);
}

type ManualTx = Pick<TransactionRow, 'id' | 'merchant' | 'type'>;

// Manual classification (Telegram buttons): classify and learn atomically.
// Synchronous because drizzle's bun-sqlite transactions can't await.
export function classifyTransaction(tx: ManualTx, walletId: number): void {
  const now = new Date().toISOString();
  db.transaction((t) => {
    t.update(transactions)
      .set({ walletId, status: 'classified', classifiedAt: now, updatedAt: now })
      .where(eq(transactions.id, tx.id))
      .run();
    learnRule(tx, walletId, t, now);
  });
}

// Undo of classifyTransaction: back to pending, forgetting the rule it created
// (the one stamped with its classifiedAt), but not a rule it only updated.
export function unclassifyTransaction(tx: ManualTx & Pick<TransactionRow, 'classifiedAt'>): void {
  const now = new Date().toISOString();
  db.transaction((t) => {
    if (teachesRule(tx) && tx.classifiedAt) deleteExactRule(tx.merchant, tx.classifiedAt, t);
    t.update(transactions)
      .set({ walletId: null, status: 'pending', classifiedAt: null, updatedAt: now })
      .where(eq(transactions.id, tx.id))
      .run();
  });
}
