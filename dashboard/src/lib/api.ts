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

// Build a mutation error that surfaces what the server said — the error code
// from errorHandler ({ error, requestId }) or the first zod issue from a
// zValidator 400 — instead of a generic "update failed".
export async function apiError(res: Response, fallback: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as {
    error?: unknown;
    message?: unknown;
  } | null;
  if (typeof body?.error === 'string') return new Error(body.error);
  const issue = (body?.error as { issues?: Array<{ path?: unknown[]; message?: string }> } | null)
    ?.issues?.[0];
  if (issue?.message) {
    return new Error(
      issue.path?.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    );
  }
  if (typeof body?.message === 'string') return new Error(body.message);
  return new Error(fallback);
}
