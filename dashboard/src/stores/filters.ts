import { defineStore } from 'pinia';
import { currentMonth } from 'shared';

export const useFiltersStore = defineStore('filters', {
  state: () => ({
    activeMonth: currentMonth(),
    txWalletId: null as number | null,
    txStatus: null as 'pending' | 'classified' | 'ignored' | null,
  }),
  actions: {
    setMonth(m: string) {
      this.activeMonth = m;
    },
    setWallet(id: number | null) {
      this.txWalletId = id;
    },
    setStatus(s: 'pending' | 'classified' | 'ignored' | null) {
      this.txStatus = s;
    },
  },
});
