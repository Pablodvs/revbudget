import { defineStore } from 'pinia';

type Mode = 'dark' | 'light';

export const useThemeStore = defineStore('theme', {
  state: () => ({ mode: 'dark' as Mode }),
  actions: {
    init() {
      const stored = localStorage.getItem('revbudget:theme') as Mode | null;
      this.mode = stored ?? 'dark';
      this.apply();
    },
    toggle() {
      this.mode = this.mode === 'dark' ? 'light' : 'dark';
      localStorage.setItem('revbudget:theme', this.mode);
      this.apply();
    },
    apply() {
      const root = document.documentElement;
      root.classList.toggle('dark', this.mode === 'dark');
      root.classList.toggle('light', this.mode === 'light');
    },
  },
});
