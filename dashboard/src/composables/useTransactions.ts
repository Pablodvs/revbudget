import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import type { Transaction, TransactionCreate, TransactionUpdate } from 'shared';
import type { MaybeRefOrGetter } from 'vue';
import { computed, toValue } from 'vue';
import { api, apiError } from '../lib/api';

type Filters = {
  month?: string;
  walletId?: number | null;
  status?: 'pending' | 'pending_confirmation' | 'classified' | 'ignored' | null;
  limit?: number;
};

export function useTransactions(filters: MaybeRefOrGetter<Filters>) {
  const key = computed(() => ['transactions', toValue(filters)]);
  return useQuery({
    queryKey: key,
    queryFn: async (): Promise<Transaction[]> => {
      const f = toValue(filters);
      const query: Record<string, string> = {};
      if (f.month) query.month = f.month;
      if (f.walletId != null) query.walletId = String(f.walletId);
      if (f.status) query.status = f.status;
      if (f.limit) query.limit = String(f.limit);
      const res = await api.api.transactions.$get({ query });
      if (!res.ok) throw new Error('failed to fetch transactions');
      return (await res.json()) as Transaction[];
    },
    placeholderData: keepPreviousData,
  });
}

export function useUpdateTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: TransactionUpdate }) => {
      const res = await api.api.transactions[':id'].$put({
        param: { id: String(id) },
        json: patch,
      });
      if (!res.ok) throw await apiError(res, "Couldn't save the transaction.");
      return (await res.json()) as Transaction;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transactions'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      qc.invalidateQueries({ queryKey: ['rules'] });
    },
  });
}

export function useCreateTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: TransactionCreate) => {
      const res = await api.api.transactions.$post({ json: body });
      if (!res.ok) throw await apiError(res, "Couldn't create the transaction.");
      return (await res.json()) as Transaction;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transactions'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export function useDeleteTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await api.api.transactions[':id'].$delete({ param: { id: String(id) } });
      if (!res.ok) throw await apiError(res, "Couldn't delete the transaction.");
      return true;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transactions'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}
