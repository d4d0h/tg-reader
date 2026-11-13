import { describe, expect, it } from 'vitest';
import {
  buildReadScopeClause,
  decodeCursor,
  encodeCursor,
  hashToken,
  json,
  parseJsonColumn,
  toISO,
} from './helpers';
import type { RoleRow } from './types';

describe('json()', () => {
  it('sets JSON content type and CORS headers', () => {
    const res = json({ ok: true });
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('X-Ingest-Token');
  });

  it('carries the given status', async () => {
    const res = json({ ok: false }, 401);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false });
  });
});

describe('toISO()', () => {
  it('returns null for null', () => {
    expect(toISO(null)).toBeNull();
  });

  it('renders epoch seconds as UTC ISO', () => {
    expect(toISO(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(toISO(1700000000)).toBe('2023-11-14T22:13:20.000Z');
  });
});

describe('hashToken()', () => {
  it('produces the SHA-256 hex digest', async () => {
    expect(await hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('parseJsonColumn()', () => {
  it('returns null for null, non-string and invalid JSON', () => {
    expect(parseJsonColumn(null)).toBeNull();
    expect(parseJsonColumn(42)).toBeNull();
    expect(parseJsonColumn('not json')).toBeNull();
  });

  it('returns null for valid JSON that is not an array', () => {
    expect(parseJsonColumn('{"a":1}')).toBeNull();
  });

  it('returns the array for a valid string array', () => {
    expect(parseJsonColumn('["a","b"]')).toEqual(['a', 'b']);
  });
});

function role(partial: Partial<RoleRow>): RoleRow {
  return partial as RoleRow;
}

describe('buildReadScopeClause()', () => {
  it('returns no restriction for null role and read_mode=all', () => {
    expect(buildReadScopeClause(null, 'm', 2)).toEqual({ clause: '', binds: [] });
    expect(buildReadScopeClause(role({ read_mode: 'all' }), 'm', 2)).toEqual({ clause: '', binds: [] });
  });

  it('returns no restriction when a scoped role has no ids or labels', () => {
    const r = role({ read_mode: 'whitelist', read_chat_ids: null, read_labels: null });
    expect(buildReadScopeClause(r, 'm', 2)).toEqual({ clause: '', binds: [] });
  });

  it('whitelists chat ids with = ANY', () => {
    const r = role({ read_mode: 'whitelist', read_chat_ids: ['1', '2'], read_labels: null });
    const { clause, binds } = buildReadScopeClause(r, 'm', 3);
    expect(clause).toBe('AND (m.tg_chat_id = ANY($3::text[]))');
    expect(binds).toEqual([['1', '2']]);
  });

  it('blacklists chat ids with != ALL', () => {
    const r = role({ read_mode: 'blacklist', read_chat_ids: ['1'], read_labels: null });
    const { clause, binds } = buildReadScopeClause(r, '', 2);
    expect(clause).toBe('AND (tg_chat_id != ALL($2::text[]))');
    expect(binds).toEqual([['1']]);
  });

  it('joins ids and labels with OR for whitelist, AND for blacklist', () => {
    const wl = role({ read_mode: 'whitelist', read_chat_ids: ['1'], read_labels: ['vip'] });
    const whitelist = buildReadScopeClause(wl, 'm', 2, 1);
    expect(whitelist.clause).toContain(' OR ');
    expect(whitelist.clause).toContain('cc.account_id = $1');
    expect(whitespaceNormalized(whitelist.clause)).toBe(
      'AND (m.tg_chat_id = ANY($2::text[]) OR m.tg_chat_id IN (SELECT cc.tg_chat_id FROM chat_config cc WHERE cc.account_id = $1 AND cc.label = ANY($3::text[])))',
    );

    const bl = role({ read_mode: 'blacklist', read_chat_ids: ['1'], read_labels: ['vip'] });
    const blacklist = buildReadScopeClause(bl, 'm', 2, 1);
    expect(blacklist.clause).toContain(' AND ');
    expect(blacklist.clause).toContain('NOT IN');
  });
});

function whitespaceNormalized(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

describe('cursors', () => {
  it('round-trips id and sent_at', () => {
    const cursor = encodeCursor(123, 1700000000);
    expect(decodeCursor(cursor)).toEqual({ id: 123, sent_at: 1700000000 });
  });

  it('returns null for empty input', () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it('returns null for garbage and for well-formed base64 of the wrong shape', () => {
    expect(decodeCursor('!!!not-base64!!!')).toBeNull();
    expect(decodeCursor(btoa('{"id":"not-a-number"}'))).toBeNull();
    expect(decodeCursor(btoa('[1,2]'))).toBeNull();
  });
});
