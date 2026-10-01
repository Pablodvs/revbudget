import { defineStore } from 'pinia';

type Mode = 'dark' | 'light';

const STORAGE_KEY = 'revbudget:theme';

export const useThemeStore = defineStore('theme', {
  state: () => ({ mode: 'dark' as Mode }),
  getters: {
    // ECharts paints on a canvas, so it can't pick up the CSS palette flip.
    chartColors: (state) =>
      state.mode === 'dark'
        ? {
            text: '#a1a1aa',
            grid: '#27272a',
            axis: '#3f3f46',
            tooltipBg: '#18181b',
            tooltipText: '#f4f4f5',
          }
        : {
            text: '#52525b',
            grid: '#e4e4e7',
            axis: '#d4d4d8',
            tooltipBg: '#ffffff',
            tooltipText: '#18181b',
          },
  },
  actions: {
    // Storage throws when site data is blocked; the choice then just isn't
    // remembered, rather than the error blanking the whole app.
    init() {
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(STORAGE_KEY);
      } catch {}
      this.mode = stored === 'light' ? 'light' : 'dark';
      this.apply();
    },
    toggle() {
      this.mode = this.mode === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(STORAGE_KEY, this.mode);
      } catch {}
      this.apply();
    },
    apply() {
      const root = document.documentElement;
      root.classList.toggle('dark', this.mode === 'dark');
      root.classList.toggle('light', this.mode === 'light');
    },
  },
});
