import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { config } from '../config';
import { normalizeWithOllama } from './ollama-normalizer';

// The real config, mutated and restored: mock.module would replace the module
// for every test file that runs after this one.
const originalConfig = { ...config };

const originalFetch = globalThis.fetch;
const fixedDate = new Date('2026-04-17T10:00:00Z');

function genResponse(response: string, status = 200): Response {
  return new Response(JSON.stringify({ response }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  Object.assign(config, {
    OLLAMA_ENABLED: true,
    OLLAMA_URL: 'http://localhost:11434',
    OLLAMA_MODEL: 'test-model',
    OLLAMA_TIMEOUT_MS: 1000,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  Object.assign(config, originalConfig);
});

describe('normalizeWithOllama', () => {
  test('returns null without calling fetch when disabled', async () => {
    config.OLLAMA_ENABLED = false;
    const fetchMock = mock(async () => new Response('{}'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out = await normalizeWithOllama('You paid €12.00 at Foo', 'rid1', fixedDate);
    expect(out).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  test('builds a canonical expense line from JSON extraction', async () => {
    const fetchMock = mock(async () =>
      genResponse('{"type":"expense","amount":12.34,"currency":"EUR","merchant":"LIDL"}'),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out = await normalizeWithOllama('You paid €12.34 at LIDL', 'rid2', fixedDate);
    expect(out?.canonical).toBe('You paid €12.34 at LIDL');
    expect(out?.parsed.type).toBe('expense');
    expect(out?.parsed.amount).toBe(1234);
    expect(out?.parsed.currency).toBe('EUR');
    expect(out?.parsed.merchantDisplay).toBe('LIDL');
    expect(out?.parsed.transactionDate).toBe(fixedDate.toISOString());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('posts to /api/generate with system, format:json, and prompt', async () => {
    let capturedUrl = '';
    let capturedBody: unknown = null;
    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return genResponse('{"type":"expense","amount":1,"currency":"EUR","merchant":"X"}');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await normalizeWithOllama('messy input', 'rid-req', fixedDate);
    expect(capturedUrl).toBe('http://localhost:11434/api/generate');
    const body = capturedBody as {
      model: string;
      system: string;
      prompt: string;
      stream: boolean;
      format: string;
    };
    expect(body.model).toBe('test-model');
    expect(body.stream).toBe(false);
    expect(body.format).toBe('json');
    expect(body.prompt).toBe('messy input');
    expect(body.system).toContain('expense');
    expect(body.system).toContain('income');
    expect(body.system).toContain('refund');
  });

  test('builds a canonical income line', async () => {
    const fetchMock = mock(async () =>
      genResponse('{"type":"income","amount":30,"currency":"EUR","merchant":"John Doe"}'),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await normalizeWithOllama('John Doe sent you €30.00', 'rid', fixedDate);
    expect(out?.canonical).toBe('John Doe sent you €30.00');
    expect(out?.parsed.type).toBe('income');
  });

  test('builds a canonical refund line', async () => {
    const fetchMock = mock(async () =>
      genResponse('{"type":"refund","amount":5,"currency":"GBP","merchant":"Booking.com"}'),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await normalizeWithOllama('Refund: £5.00 by Booking.com', 'rid', fixedDate);
    expect(out?.canonical).toBe('You were refunded £5.00 by Booking.com');
    expect(out?.parsed.type).toBe('refund');
  });

  test('tolerates code fences and surrounding whitespace in JSON output', async () => {
    const fetchMock = mock(async () =>
      genResponse(
        '```json\n{"type":"expense","amount":7.75,"currency":"EUR","merchant":"AMAZON"}\n```',
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await normalizeWithOllama('You paid €7.75 at AMAZON', 'rid', fixedDate);
    expect(out?.canonical).toBe('You paid €7.75 at AMAZON');
  });

  test('extracts the JSON object from surrounding prose', async () => {
    const fetchMock = mock(async () =>
      genResponse('Sure! {"type":"expense","amount":3,"currency":"EUR","merchant":"Cafe"} Done.'),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await normalizeWithOllama('You paid €3.00 at Cafe', 'rid', fixedDate);
    expect(out?.canonical).toBe('You paid €3.00 at Cafe');
  });

  test('returns null on HTTP 500', async () => {
    const fetchMock = mock(async () => new Response('boom', { status: 500 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await normalizeWithOllama('raw', 'rid3', fixedDate);
    expect(out).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('returns null when response is empty', async () => {
    const fetchMock = mock(async () => genResponse('   '));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await normalizeWithOllama('raw', 'rid4', fixedDate);
    expect(out).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('returns null when model classifies as none', async () => {
    const fetchMock = mock(async () =>
      genResponse('{"type":"none","amount":0,"currency":"EUR","merchant":""}'),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await normalizeWithOllama('hello', 'rid5', fixedDate);
    expect(out).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('returns null when JSON output is malformed', async () => {
    const fetchMock = mock(async () => genResponse('not json at all'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await normalizeWithOllama('raw', 'rid-bad', fixedDate);
    expect(out).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('returns null when extracted type is unknown', async () => {
    const fetchMock = mock(async () =>
      genResponse('{"type":"transfer","amount":1,"currency":"EUR","merchant":"X"}'),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await normalizeWithOllama('raw', 'rid-bad2', fixedDate);
    expect(out).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('returns null when merchant is missing for a non-none type', async () => {
    const fetchMock = mock(async () =>
      genResponse('{"type":"expense","amount":1,"currency":"EUR","merchant":""}'),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await normalizeWithOllama('raw', 'rid-nomerch', fixedDate);
    expect(out).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('returns null when extracted amount exceeds ceiling', async () => {
    const fetchMock = mock(async () =>
      genResponse('{"type":"expense","amount":9999999999,"currency":"EUR","merchant":"X"}'),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await normalizeWithOllama('raw', 'rid-huge', fixedDate);
    expect(out).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('rejects a merchant that re-parses as a different transaction', async () => {
    // Canonical "You paid €999999.00 at Rent sent you €5.00" parses as a
    // 99,999,900-cent expense, not the €5 income the model extracted.
    const fetchMock = mock(async () =>
      genResponse(
        '{"type":"income","amount":5,"currency":"EUR","merchant":"You paid €999999.00 at Rent"}',
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await normalizeWithOllama('raw', 'rid-inject', fixedDate);
    expect(out).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('rejects a round trip that only flips the type', async () => {
    const fetchMock = mock(async () =>
      genResponse('{"type":"income","amount":5,"currency":"EUR","merchant":"You paid €5.00 at X"}'),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await normalizeWithOllama('raw', 'rid-flip', fixedDate);
    expect(out).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('rejects a round trip that only changes the currency', async () => {
    // "You paid £5.00 at Foo: You paid €5.00 at Bar" re-parses as a €5.00
    // expense at Bar: same type and amount, so only the currency check catches it.
    const fetchMock = mock(async () =>
      genResponse(
        '{"type":"expense","amount":5,"currency":"GBP","merchant":"Foo: You paid €5.00 at Bar"}',
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await normalizeWithOllama('raw', 'rid-currency', fixedDate);
    expect(out).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('returns null on thrown error (timeout/abort)', async () => {
    const fetchMock = mock(async () => {
      throw new Error('aborted');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await normalizeWithOllama('raw', 'rid6', fixedDate);
    expect(out).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
