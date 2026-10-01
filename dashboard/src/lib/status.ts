import type { TransactionStatus } from 'shared';

// Badge label and colours per transaction status, shared by TxRow and the
// Transactions table.
export const STATUS_META: Record<TransactionStatus, { label: string; cls: string }> = {
  pending: { label: 'pending', cls: 'bg-amber-400/10 text-amber-300' },
  pending_confirmation: { label: 'awaiting confirm', cls: 'bg-sky-400/10 text-sky-300' },
  classified: { label: 'classified', cls: 'bg-emerald-500/10 text-emerald-300' },
  ignored: { label: 'ignored', cls: 'bg-zinc-800 text-zinc-400' },
};
