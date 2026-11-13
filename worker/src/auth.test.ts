import { describe, expect, it } from 'vitest';
import { authenticate, timingSafeTokenEqual } from './auth';
import type { Env } from './types';

function envWithToken(token: string): Env {
  return { INGEST_TOKEN: token } as unknown as Env;
}

function requestWithToken(token: string | null): Request {
  const headers = new Headers();
  if (token !== null) headers.set('X-Ingest-Token', token);
  return new Request('https://worker.test/search?q=hi', { headers });
}

describe('timingSafeTokenEqual()', () => {
  it('accepts equal strings', async () => {
    await expect(timingSafeTokenEqual('a'.repeat(64), 'a'.repeat(64))).resolves.toBe(true);
  });

  it('rejects different strings of equal length', async () => {
    await expect(timingSafeTokenEqual('a'.repeat(64), 'b'.repeat(64))).resolves.toBe(false);
  });

  it('rejects different lengths without comparing', async () => {
    await expect(timingSafeTokenEqual('short', 'short-but-longer')).resolves.toBe(false);
  });

  it('accepts two empty strings', async () => {
    await expect(timingSafeTokenEqual('', '')).resolves.toBe(true);
  });
});

describe('authenticate() (non-MCP routes)', () => {
  const TOKEN = 't'.repeat(64);

  it('returns null for the correct X-Ingest-Token', async () => {
    await expect(authenticate(requestWithToken(TOKEN), envWithToken(TOKEN))).resolves.toBeNull();
  });

  it('returns a 401 JSON response for a wrong token', async () => {
    const res = await authenticate(requestWithToken('wrong-token'), envWithToken(TOKEN));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    expect(await res!.json()).toEqual({ ok: false, error: 'Unauthorized' });
  });

  it('returns a 401 when the header is missing', async () => {
    const res = await authenticate(requestWithToken(null), envWithToken(TOKEN));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });
});
