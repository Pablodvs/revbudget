import { SQLiteError } from 'bun:sqlite';
import type { Context, ErrorHandler, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { config } from '../config';
import { log } from '../lib/log';

export const requestId: MiddlewareHandler = async (c, next) => {
  const id = crypto.randomUUID();
  c.set('requestId', id);
  c.header('X-Request-Id', id);
  await next();
};

const STATUS_TEXT: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  422: 'unprocessable_entity',
  429: 'rate_limited',
};

// Constraint violations are client errors (a taken rule pattern, a walletId
// that doesn't exist), not server faults.
const CONSTRAINT_ERRORS: Record<string, { status: ContentfulStatusCode; error: string }> = {
  SQLITE_CONSTRAINT_UNIQUE: { status: 409, error: 'duplicate' },
  SQLITE_CONSTRAINT_FOREIGNKEY: { status: 400, error: 'invalid_reference' },
};

// App code throws HTTPExceptions with snake_case codes (wallet_not_found, …):
// stable and safe to return in every environment. Anything else (framework
// prose such as "Malformed JSON in request body") collapses to the status text.
const APP_ERROR_CODE = /^[a-z][a-z0-9_]*$/;

export const errorHandler: ErrorHandler = (err, c: Context) => {
  const id = (c.get('requestId') as string | undefined) ?? 'unknown';
  if (err instanceof HTTPException && err.status < 500) {
    log.warn(id, 'http_exception', { status: err.status });
    const error = APP_ERROR_CODE.test(err.message)
      ? err.message
      : (STATUS_TEXT[err.status] ?? 'http_error');
    return c.json({ error, requestId: id }, err.status as ContentfulStatusCode);
  }
  const constraint = err instanceof SQLiteError ? CONSTRAINT_ERRORS[err.code ?? ''] : undefined;
  if (constraint) {
    log.warn(id, 'constraint_violation', { error: constraint.error });
    return c.json({ error: constraint.error, requestId: id }, constraint.status);
  }
  log.error(id, 'unhandled_error', { name: err instanceof Error ? err.name : 'unknown' });
  if (config.NODE_ENV !== 'production' && err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  return c.json({ error: 'internal_error', requestId: id }, 500);
};
