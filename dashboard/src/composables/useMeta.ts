import { useQuery } from '@tanstack/vue-query';
import type { Meta } from 'shared';
import { api } from '../lib/api';

// Public, so the sign-in page can use it too. It only changes when the demo
// resets overnight, hence the long staleTime. A failed request leaves data
// undefined, which every caller reads as "not a demo".
export function useMeta() {
  return useQuery({
    queryKey: ['meta'],
    queryFn: async (): Promise<Meta> => {
      const res = await api.api.meta.$get();
      if (!res.ok) throw new Error('failed to fetch meta');
      return (await res.json()) as Meta;
    },
    staleTime: 1000 * 60 * 60,
  });
}
