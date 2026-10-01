import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { config } from '../config';
import { validate } from '../lib/validate';
import { errorHandler, requestId } from './error-handler';

const originalNodeEnv = config.NODE_ENV;
afterEach(() => {
  (config as { NODE_ENV: string }).NODE_ENV = originalNodeEnv;
});

// Real bun:sqlite errors, so the mapping is tested against the actual thrown shape.
const sqlite = new Database(':memory:');
sqlite.exec('PRAGMA foreign_keys = ON;');
sqlite.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT UNIQUE)');
sqlite.exec('CREATE TABLE child (parent_id INTEGER REFERENCES parent(id))');
sqlite.exec("INSERT INTO parent (id, name) VALUES (1, 'taken')");

const app = new Hono()
  .use('*', requestId)
  .get('/app-code', () => {
    throw new HTTPException(404, { message: 'wallet_not_found' });
  })
  .get('/framework-prose', () => {
    throw new HTTPException(400, { message: 'Malformed JSON in request body' });
  })
  .get('/unique', (c) => {
    sqlite.exec("INSERT INTO parent (name) VALUES ('taken')");
    return c.text('unreachable');
  })
  .get('/foreign-key', (c) => {
    sqlite.exec('INSERT INTO child (parent_id) VALUES (999)');
    return c.text('unreachable');
  })
  .get('/crash', () => {
    throw new Error('internal detail /srv/db.sqlite');
  })
  .post(
    '/validated',
    validate('json', z.object({ kind: z.enum(['a', 'b']), n: z.number() })),
    (c) => c.json(c.req.valid('json')),
  );
app.onError(errorHandler);

async function call(path: string, init?: RequestInit) {
  const res = await app.request(path, init);
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

describe('errorHandler', () => {
  test('passes app error codes through in production', async () => {
    (config as { NODE_ENV: string }).NODE_ENV = 'production';
    const { status, body } = await call('/app-code');
    expect(status).toBe(404);
    expect(body.error).toBe('wallet_not_found');
    expect(typeof body.requestId).toBe('string');
  });

  test('collapses non-code HTTPException messages to the status text', async () => {
    const { status, body } = await call('/framework-prose');
    expect(status).toBe(400);
    expect(body.error).toBe('bad_request');
  });

  test('UNIQUE violation -> 409 duplicate', async () => {
    const { status, body } = await call('/unique');
    expect(status).toBe(409);
    expect(body.error).toBe('duplicate');
  });

  test('FOREIGN KEY violation -> 400 invalid_reference', async () => {
    const { status, body } = await call('/foreign-key');
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_reference');
  });

  test('unexpected errors stay a generic 500', async () => {
    (config as { NODE_ENV: string }).NODE_ENV = 'production';
    const { status, body, text } = await call('/crash');
    expect(status).toBe(500);
    expect(body.error).toBe('internal_error');
    expect(text).not.toContain('internal detail');
  });
});

describe('validate', () => {
  test('reports path + message only, never the received input or enum options', async () => {
    const { status, body, text } = await call('/validated', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: '<img src=x onerror=alert(1)>' }),
    });
    expect(status).toBe(400);
    expect(body.error).toBe('validation_failed');
    expect(typeof body.requestId).toBe('string');
    expect(body.issues).toEqual([
      { path: 'kind', message: 'Invalid value' },
      { path: 'n', message: 'Required' },
    ]);
    expect(text).not.toContain('<img');
    expect(text).not.toContain('received');
  });

  test('passes valid input through', async () => {
    const { status, body } = await call('/validated', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'a', n: 1 }),
    });
    expect(status).toBe(200);
    expect(body).toEqual({ kind: 'a', n: 1 });
  });
});
