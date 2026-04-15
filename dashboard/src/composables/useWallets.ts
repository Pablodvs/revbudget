import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import type { Wallet, WalletCreate, WalletUpdate } from 'shared';
import { api } from '../lib/api';

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

export function useWallet(id: number) {
  return useQuery({
    queryKey: ['wallet', id],
    queryFn: async (): Promise<Wallet> => {
      const res = await api.api.wallets[':id'].$get({ param: { id: String(id) } });
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
      if (!res.ok) throw new Error('update failed');
      return (await res.json()) as Wallet;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wallets'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export function useCreateWallet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: WalletCreate) => {
      const res = await api.api.wallets.$post({ json: body });
      if (!res.ok) throw new Error('create failed');
      return (await res.json()) as Wallet;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['wallets'] }),
  });
}

export function useDeleteWallet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await api.api.wallets[':id'].$delete({
        param: { id: String(id) },
      });
      if (!res.ok) throw new Error('delete failed');
      return true;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wallets'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      qc.invalidateQueries({ queryKey: ['transactions'] });
      qc.invalidateQueries({ queryKey: ['rules'] });
    },
  });
}
