import { hc } from 'hono/client';
import type { AppType } from 'server';
import { router } from '../router';

const baseUrl = import.meta.env.VITE_API_URL ?? '';

async function customFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, { ...init, credentials: 'include' });
  if (res.status === 401 && router.currentRoute.value.name !== 'login') {
    router.push({ name: 'login', query: { next: router.currentRoute.value.fullPath } });
  }
  return res;
}

export const api = hc<AppType>(baseUrl, { fetch: customFetch });
