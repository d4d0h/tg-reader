import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuth, fetchStats, getAuth, setAuth } from './api';

const AUTH = { workerUrl: 'https://worker.test', token: 'tok-123', accountId: '42' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  clearAuth();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('auth storage', () => {
  it('round-trips setAuth/getAuth via sessionStorage', () => {
    setAuth(AUTH);
    expect(getAuth()).toEqual(AUTH);
  });

  it('clearAuth removes the stored session', () => {
    setAuth(AUTH);
    clearAuth();
    expect(getAuth()).toBeNull();
    expect(sessionStorage.getItem('tgr_auth')).toBeNull();
  });
});

describe('req()', () => {
  it('rejects with "not authenticated" when no session exists', async () => {
    await expect(fetchStats()).rejects.toThrow('not authenticated');
  });

  it('sends the token and account headers to the worker URL', async () => {
    setAuth(AUTH);
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ total_messages: 1 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchStats()).resolves.toEqual({ total_messages: 1 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://worker.test/stats');
    const headers = init!.headers as Record<string, string>;
    expect(headers['X-Ingest-Token']).toBe('tok-123');
    expect(headers['X-Account-ID']).toBe('42');
  });

  it('normalizes a trailing slash on the worker URL', async () => {
    setAuth({ ...AUTH, workerUrl: 'https://worker.test/' });
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await fetchStats();
    expect(fetchMock.mock.calls[0]![0]).toBe('https://worker.test/stats');
  });

  it('surfaces the error field from a non-2xx response', async () => {
    setAuth(AUTH);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'Unauthorized' }, 401)));

    await expect(fetchStats()).rejects.toThrow('Unauthorized');
  });

  it('falls back to the HTTP status when the error body is not JSON', async () => {
    setAuth(AUTH);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>gateway</html>', { status: 502 })),
    );

    await expect(fetchStats()).rejects.toThrow('HTTP 502');
  });
});
