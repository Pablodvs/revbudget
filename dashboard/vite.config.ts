import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig, loadEnv } from 'vite';

// The repo root's .env configures the server too, so the dev proxy follows its PORT.
const envDir = resolve(__dirname, '..');

export default defineConfig(({ mode }) => ({
  envDir,
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      shared: resolve(__dirname, '../shared/src/index.ts'),
      server: resolve(__dirname, '../server/src/app.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': `http://localhost:${loadEnv(mode, envDir, '').PORT || 3000}`,
    },
  },
}));
