import { useQuery } from '@tanstack/vue-query';
import type { MonthlyStats, Trends } from 'shared';
import type { MaybeRefOrGetter } from 'vue';
import { computed, toValue } from 'vue';
import { api } from '../lib/api';

export function useMonthlyStats(month: MaybeRefOrGetter<string>) {
  const key = computed(() => ['stats', 'monthly', toValue(month)]);
  return useQuery({
    queryKey: key,
    queryFn: async (): Promise<MonthlyStats> => {
      const res = await api.api.stats.monthly.$get({ query: { month: toValue(month) } });
      if (!res.ok) throw new Error('failed to fetch stats');
      return (await res.json()) as MonthlyStats;
    },
  });
}

export function useTrends() {
  return useQuery({
    queryKey: ['stats', 'trends'],
    queryFn: async (): Promise<Trends> => {
      const res = await api.api.stats.trends.$get();
      if (!res.ok) throw new Error('failed to fetch trends');
      return (await res.json()) as Trends;
    },
  });
}
