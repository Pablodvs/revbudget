import { hc } from 'hono/client';
import type { AppType } from 'server';

const baseUrl = import.meta.env.VITE_API_URL ?? '';
const token = import.meta.env.VITE_API_TOKEN;

export const api = hc<AppType>(baseUrl, {
  headers: token ? { Authorization: `Bearer ${token}` } : undefined,
});
