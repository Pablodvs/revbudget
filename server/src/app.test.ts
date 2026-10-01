import { afterAll, describe, expect, test } from 'bun:test';
import { stopRateLimitSweeper } from './middleware/rate-limit';

const { app } = await import('./app');

afterAll(() => {
  stopRateLimitSweeper();
});

describe('unknown /api/* paths', () => {
  test('GET on an unknown API path returns JSON 404, not the SPA', async () => {
    const res = await app.request('/api/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe('not_found');
    expect(typeof body.requestId).toBe('string');
  });

  test('unsupported verb on /api/auth/* returns JSON 404', async () => {
    const res = await app.request('/api/auth/whatever', { method: 'PUT' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });

  test('/api/health still resolves', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });
});
