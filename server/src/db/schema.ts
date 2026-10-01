import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

export * from './auth-schema';

export const PARSE_FAILURE_ERROR_CODES = ['empty', 'no_match', 'invalid_amount'] as const;
export type ParseFailureErrorCode = (typeof PARSE_FAILURE_ERROR_CODES)[number];

export const TRANSACTION_TYPES = ['expense', 'income', 'refund', 'adjustment'] as const;
export type TransactionTypeCode = (typeof TRANSACTION_TYPES)[number];

export const wallets = sqliteTable('wallets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  budget: integer('budget').notNull(),
  currency: text('currency').notNull().default('EUR'),
  color: text('color').notNull(),
  icon: text('icon'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const transactions = sqliteTable(
  'transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    walletId: integer('wallet_id').references(() => wallets.id, { onDelete: 'set null' }),
    amount: integer('amount').notNull(),
    currency: text('currency').notNull().default('EUR'),
    merchant: text('merchant').notNull(),
    merchantDisplay: text('merchant_display').notNull(),
    description: text('description'),
    rawText: text('raw_text').notNull(),
    status: text('status', { enum: ['pending', 'pending_confirmation', 'classified', 'ignored'] })
      .notNull()
      .default('pending'),
    telegramMessageId: integer('telegram_message_id'),
    classifiedAt: text('classified_at'),
    transactionDate: text('transaction_date').notNull(),
    type: text('type', { enum: TRANSACTION_TYPES }).notNull().default('expense'),
    relatedTxId: integer('related_tx_id').references((): AnySQLiteColumn => transactions.id, {
      onDelete: 'set null',
    }),
    createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    statusIdx: index('idx_tx_status').on(t.status),
    walletIdx: index('idx_tx_wallet').on(t.walletId),
    dateIdx: index('idx_tx_date').on(t.transactionDate),
    typeIdx: index('idx_tx_type').on(t.type),
    statusCheck: check(
      'status_check',
      sql`${t.status} IN ('pending','pending_confirmation','classified','ignored')`,
    ),
    amountCheck: check('amount_positive', sql`${t.amount} > 0`),
    typeCheck: check('type_check', sql`${t.type} IN ('expense','income','refund','adjustment')`),
  }),
);

export const parseFailures = sqliteTable(
  'parse_failures',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    rawText: text('raw_text').notNull(),
    errorCode: text('error_code', { enum: PARSE_FAILURE_ERROR_CODES }).notNull(),
    receivedAt: text('received_at').notNull(),
    telegramMessageId: integer('telegram_message_id'),
    resolvedAt: text('resolved_at'),
    createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    resolvedIdx: index('idx_pf_resolved').on(t.resolvedAt),
    errorCheck: check(
      'error_code_check',
      sql`${t.errorCode} IN ('empty','no_match','invalid_amount')`,
    ),
  }),
);

export const merchantRules = sqliteTable(
  'merchant_rules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    pattern: text('pattern').notNull().unique(),
    walletId: integer('wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'cascade' }),
    matchType: text('match_type', { enum: ['exact', 'contains'] })
      .notNull()
      .default('exact'),
    requireConfirmation: integer('require_confirmation', { mode: 'boolean' })
      .notNull()
      .default(true),
    createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    matchCheck: check('match_type_check', sql`${t.matchType} IN ('exact','contains')`),
  }),
);

export type WalletRow = typeof wallets.$inferSelect;
export type WalletInsert = typeof wallets.$inferInsert;
export type TransactionRow = typeof transactions.$inferSelect;
export type TransactionInsert = typeof transactions.$inferInsert;
export type MerchantRuleRow = typeof merchantRules.$inferSelect;
export type MerchantRuleInsert = typeof merchantRules.$inferInsert;
export type ParseFailureRow = typeof parseFailures.$inferSelect;
export type ParseFailureInsert = typeof parseFailures.$inferInsert;
