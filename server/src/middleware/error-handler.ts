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

function statusText(status: number): string {
  return STATUS_TEXT[status] ?? 'http_error';
}

export const errorHandler: ErrorHandler = (err, c: Context) => {
  const id = (c.get('requestId') as string | undefined) ?? 'unknown';
  if (err instanceof HTTPException) {
    log.warn(id, 'http_exception', { status: err.status });
    const body =
      config.NODE_ENV === 'production'
        ? statusText(err.status)
        : err.message || statusText(err.status);
    return c.json({ error: body, requestId: id }, err.status as ContentfulStatusCode);
  }
  log.error(id, 'unhandled_error', { name: err instanceof Error ? err.name : 'unknown' });
  if (config.NODE_ENV !== 'production' && err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  return c.json({ error: 'internal_error', requestId: id }, 500);
};
