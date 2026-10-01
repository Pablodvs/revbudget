import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import type { Wallet, WalletCreate, WalletUpdate } from 'shared';
import type { MaybeRefOrGetter } from 'vue';
import { computed, toValue } from 'vue';
import { api, apiError } from '../lib/api';

export function useWallets() {
  return useQuery({
    queryKey: ['wallets'],
    queryFn: async (): Promise<Wallet[]> => {
      const res = await api.api.wallets.$get();
      if (!res.ok) throw new Error('failed to fetch wallets');
      return (await res.json()) as Wallet[];
    },
  });
}

// Resolves to null when the wallet doesn't exist (deleted, or a malformed id
// in the URL) so the view can say "not found" instead of failing and retrying.
export function useWallet(id: MaybeRefOrGetter<number>) {
  const key = computed(() => ['wallet', toValue(id)]);
  return useQuery({
    queryKey: key,
    queryFn: async (): Promise<Wallet | null> => {
      const walletId = toValue(id);
      if (!Number.isInteger(walletId) || walletId <= 0) return null;
      const res = await api.api.wallets[':id'].$get({ param: { id: String(walletId) } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('failed to fetch wallet');
      return (await res.json()) as Wallet;
    },
  });
}

export function useUpdateWallet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: WalletUpdate }) => {
      const res = await api.api.wallets[':id'].$put({
        param: { id: String(id) },
        json: patch,
      });
      if (!res.ok) throw await apiError(res, "Couldn't save the wallet.");
      return (await res.json()) as Wallet;
    },
    onSuccess: (_wallet, { id }) => {
      qc.invalidateQueries({ queryKey: ['wallets'] });
      qc.invalidateQueries({ queryKey: ['wallet', id] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export function useCreateWallet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: WalletCreate) => {
      const res = await api.api.wallets.$post({ json: body });
      if (!res.ok) throw await apiError(res, "Couldn't create the wallet.");
      return (await res.json()) as Wallet;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wallets'] });
      // A new wallet shows up in the monthly stats and trends.
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export function useDeleteWallet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await api.api.wallets[':id'].$delete({
        param: { id: String(id) },
      });
      if (!res.ok) throw await apiError(res, "Couldn't delete the wallet.");
      return true;
    },
    onSuccess: (_ok, id) => {
      qc.invalidateQueries({ queryKey: ['wallets'] });
      qc.invalidateQueries({ queryKey: ['wallet', id] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      qc.invalidateQueries({ queryKey: ['transactions'] });
      qc.invalidateQueries({ queryKey: ['rules'] });
    },
  });
}
