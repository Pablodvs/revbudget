import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import type { MerchantRule, MerchantRuleCreate, MerchantRuleUpdate } from 'shared';
import { api, apiError } from '../lib/api';

export function useRules() {
  return useQuery({
    queryKey: ['rules'],
    queryFn: async (): Promise<MerchantRule[]> => {
      const res = await api.api['merchant-rules'].$get();
      if (!res.ok) throw new Error('failed to fetch rules');
      return (await res.json()) as MerchantRule[];
    },
  });
}

export function useCreateRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: MerchantRuleCreate) => {
      const res = await api.api['merchant-rules'].$post({ json: body });
      if (!res.ok) throw await apiError(res, 'create failed');
      return (await res.json()) as MerchantRule;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rules'] }),
  });
}

export function useUpdateRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: MerchantRuleUpdate }) => {
      const res = await api.api['merchant-rules'][':id'].$put({
        param: { id: String(id) },
        json: patch,
      });
      if (!res.ok) throw await apiError(res, 'update failed');
      return (await res.json()) as MerchantRule;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rules'] }),
  });
}

export function useDeleteRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await api.api['merchant-rules'][':id'].$delete({
        param: { id: String(id) },
      });
      if (!res.ok) throw await apiError(res, 'delete failed');
      return true;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rules'] }),
  });
}
