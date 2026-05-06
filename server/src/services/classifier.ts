import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { type WalletRow, merchantRules, wallets } from '../db/schema';

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

// Module-level cache of `contains` rules (joined with wallet). Invalidated from
// every mutation in this module and from merchant-rules routes. Assumes a single
// server process: concurrent webhook + rule-edit races can briefly serve stale
// contains rules, acceptable for this single-user app.
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

export async function upsertExactRule(pattern: string, walletId: number): Promise<void> {
  await db
    .insert(merchantRules)
    .values({ pattern, walletId, matchType: 'exact', requireConfirmation: false })
    .onConflictDoUpdate({
      target: merchantRules.pattern,
      set: { walletId, matchType: 'exact', updatedAt: new Date().toISOString() },
    });
  invalidateContainsCache();
}

export async function deleteRuleByPattern(pattern: string): Promise<void> {
  await db.delete(merchantRules).where(eq(merchantRules.pattern, pattern));
  invalidateContainsCache();
}
