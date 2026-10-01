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

// Friendly text for the server's error codes. The body shape is
// { error: <code>, issues?: [{ path, message }], requestId }.
const ERROR_TEXT: Record<string, string> = {
  duplicate: 'A rule for this merchant already exists.',
  invalid_reference: 'That wallet or linked transaction no longer exists.',
  wallet_not_found: 'That wallet no longer exists.',
  transaction_not_found: 'That transaction no longer exists.',
  rule_not_found: 'That rule no longer exists.',
  related_tx_not_found: 'No transaction has that ID.',
  related_tx_self_reference: "A transaction can't be linked to itself.",
  adjustment_requires_related_tx: 'An adjustment needs the ID of the transaction it corrects.',
  classified_requires_wallet: 'Pick a wallet before marking this as classified.',
  payload_too_large: 'That request is too large.',
  rate_limited: 'Too many requests. Wait a moment and try again.',
  demo_locked: "That's turned off in the demo.",
  demo_full: 'The demo has reached its limits for today; it resets at midnight.',
  internal_error: 'Something went wrong. Please try again.',
};

// API field names as the forms label them.
const FIELD_LABEL: Record<string, string> = {
  name: 'Name',
  budget: 'Budget',
  amount: 'Amount',
  pattern: 'Pattern',
  relatedTxId: 'Related transaction',
};

// Turn a failed response into an Error whose message can be shown as is.
// Validation failures name the first offending field; unknown codes fall
// back to the caller's message.
export async function apiError(res: Response, fallback: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as {
    error?: unknown;
    issues?: Array<{ path?: unknown; message?: unknown }>;
  } | null;
  const issue = body?.error === 'validation_failed' ? body.issues?.[0] : undefined;
  if (typeof issue?.message === 'string') {
    const path = typeof issue.path === 'string' ? issue.path : '';
    // The label already names the field, so drop Zod's "Number"/"String"
    // subject. Money limits are checked in cents; show them in the units typed.
    let message = issue.message.replace(/^(Number|String) /, '');
    if (path === 'budget' || path === 'amount') {
      message = message.replace(/\d+/g, (n) => (Number(n) / 100).toLocaleString('en-IE'));
    }
    const label = FIELD_LABEL[path] ?? path;
    return new Error(label ? `${label}: ${message}` : message);
  }
  const text = typeof body?.error === 'string' ? ERROR_TEXT[body.error] : undefined;
  return new Error(text ?? fallback);
}
