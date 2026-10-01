import { z } from 'zod';
import { MIN_CONTAINS_PATTERN_LENGTH, normalizePattern } from './normalize';

export const TransactionStatus = z.enum([
  'pending',
  'pending_confirmation',
  'classified',
  'ignored',
]);
export type TransactionStatus = z.infer<typeof TransactionStatus>;

export const TransactionType = z.enum(['expense', 'income', 'refund', 'adjustment']);
export type TransactionType = z.infer<typeof TransactionType>;

export const MatchType = z.enum(['exact', 'contains']);
export type MatchType = z.infer<typeof MatchType>;

export const MonthString = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM');

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected #rrggbb');

// Any well-formed alpha-3 code is accepted by Intl.NumberFormat without throwing;
// non-alpha junk (e.g. "€12") makes formatCents throw on every render. Uppercase
// for display consistency (Intl is case-insensitive).
const Currency = z
  .string()
  .regex(/^[A-Za-z]{3}$/, 'Expected a 3-letter currency code')
  .transform((s) => s.toUpperCase());

const PositiveIntCents = z.number().int().nonnegative();
const PositiveAmount = z.number().int().positive();
const Id = z.number().int().positive();

export const WalletSchema = z.object({
  id: Id,
  name: z.string().min(1).max(64),
  budget: PositiveIntCents,
  currency: z.string().length(3),
  color: HexColor,
  icon: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Wallet = z.infer<typeof WalletSchema>;

export const WalletCreateSchema = z.object({
  name: z.string().min(1).max(64),
  budget: PositiveIntCents,
  currency: Currency.default('EUR'),
  color: HexColor,
  icon: z.string().max(8).nullable().optional(),
  isActive: z.boolean().optional(),
});
export type WalletCreate = z.infer<typeof WalletCreateSchema>;

export const WalletUpdateSchema = WalletCreateSchema.partial();
export type WalletUpdate = z.infer<typeof WalletUpdateSchema>;

export const TransactionSchema = z.object({
  id: Id,
  walletId: Id.nullable(),
  amount: PositiveAmount,
  currency: z.string().length(3),
  merchant: z.string(),
  merchantDisplay: z.string(),
  description: z.string().nullable(),
  rawText: z.string(),
  status: TransactionStatus,
  type: TransactionType,
  relatedTxId: Id.nullable(),
  telegramMessageId: z.number().int().nullable(),
  classifiedAt: z.string().nullable(),
  transactionDate: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Transaction = z.infer<typeof TransactionSchema>;

export const TransactionUpdateSchema = z
  .object({
    walletId: Id.nullable().optional(),
    amount: PositiveAmount.optional(),
    description: z.string().max(256).nullable().optional(),
    status: TransactionStatus.optional(),
    type: TransactionType.optional(),
    relatedTxId: Id.nullable().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.type === 'adjustment' && val.relatedTxId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['relatedTxId'],
        message: 'adjustment requires relatedTxId',
      });
    }
  });
export type TransactionUpdate = z.infer<typeof TransactionUpdateSchema>;

export const TransactionCreateSchema = z
  .object({
    walletId: Id,
    amount: PositiveAmount,
    type: TransactionType,
    merchantDisplay: z.string().min(1).max(128),
    description: z.string().max(256).nullable().optional(),
    transactionDate: z.string().datetime(),
    currency: Currency.optional(),
    relatedTxId: Id.nullable().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.type === 'adjustment' && val.relatedTxId == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['relatedTxId'],
        message: 'adjustment requires relatedTxId',
      });
    }
  });
export type TransactionCreate = z.infer<typeof TransactionCreateSchema>;

export const TransactionQuerySchema = z.object({
  month: MonthString.optional(),
  walletId: z.coerce.number().int().positive().optional(),
  status: TransactionStatus.optional(),
  type: TransactionType.optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});
export type TransactionQuery = z.infer<typeof TransactionQuerySchema>;

export const MerchantRuleSchema = z.object({
  id: Id,
  pattern: z.string().min(1),
  walletId: Id,
  matchType: MatchType,
  requireConfirmation: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MerchantRule = z.infer<typeof MerchantRuleSchema>;

export const MerchantRuleCreateSchema = z
  .object({
    pattern: z.string().min(1).max(128),
    walletId: Id,
    matchType: MatchType.default('exact'),
    requireConfirmation: z.boolean().default(true),
  })
  .superRefine((val, ctx) => {
    if (val.matchType === 'contains') {
      const normalized = normalizePattern(val.pattern);
      if (normalized.length < MIN_CONTAINS_PATTERN_LENGTH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pattern'],
          message: `contains pattern must be at least ${MIN_CONTAINS_PATTERN_LENGTH} chars after normalization`,
        });
      }
    }
  });
export type MerchantRuleCreate = z.infer<typeof MerchantRuleCreateSchema>;

export const MerchantRuleUpdateSchema = z
  .object({
    pattern: z.string().min(1).max(128).optional(),
    walletId: Id.optional(),
    matchType: MatchType.optional(),
    requireConfirmation: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.matchType === 'contains' && val.pattern !== undefined) {
      const normalized = normalizePattern(val.pattern);
      if (normalized.length < MIN_CONTAINS_PATTERN_LENGTH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pattern'],
          message: `contains pattern must be at least ${MIN_CONTAINS_PATTERN_LENGTH} chars after normalization`,
        });
      }
    }
  });
export type MerchantRuleUpdate = z.infer<typeof MerchantRuleUpdateSchema>;

export const WebhookBodySchema = z.object({
  text: z.string().min(1).max(4096),
  receivedAt: z.string().datetime().optional(),
});
export type WebhookBody = z.infer<typeof WebhookBodySchema>;

export const IdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const MonthQuerySchema = z.object({
  month: MonthString.optional(),
});

export const MonthlyStatsSchema = z.object({
  month: MonthString,
  totalSpent: z.number().int().nonnegative(),
  totalBudget: z.number().int().nonnegative(),
  totalIncome: PositiveIntCents,
  transactionCount: z.number().int().nonnegative(),
  perWallet: z.array(
    z.object({
      walletId: Id,
      walletName: z.string(),
      color: HexColor,
      icon: z.string().nullable(),
      budget: PositiveIntCents,
      spent: z.number().int(),
      income: PositiveIntCents,
      transactionCount: z.number().int().nonnegative(),
    }),
  ),
});
export type MonthlyStats = z.infer<typeof MonthlyStatsSchema>;

export const TrendsSchema = z.object({
  months: z.array(MonthString),
  series: z.array(
    z.object({
      walletId: Id,
      walletName: z.string(),
      color: HexColor,
      values: z.array(z.number().int().nonnegative()),
    }),
  ),
  topMerchants: z.array(
    z.object({
      merchantDisplay: z.string(),
      total: z.number().int().nonnegative(),
      count: z.number().int().nonnegative(),
    }),
  ),
});
export type Trends = z.infer<typeof TrendsSchema>;

export const ErrorResponseSchema = z.object({
  error: z.string(),
  requestId: z.string(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
