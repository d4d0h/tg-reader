import { beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import process from 'node:process';

// Exercises the REAL /ingest and /contacts handlers against a real Postgres.
// The neon() HTTP driver is swapped for a pg Pool adapter with the same
// (text, params) -> { rows, rowCount } contract the handlers use.
vi.mock('@neondatabase/serverless', async () => {
  const pgMod = await import('pg');
  const pool = new pgMod.Pool({ connectionString: process.env['TEST_DATABASE_URL'] ?? '' });
  return {
    neon: () => (text: string, params?: unknown[]) =>
      pool.query(text, (params ?? []) as never[]).then(r => ({ rows: r.rows, rowCount: r.rowCount ?? 0 })),
  };
});

import { handleIngest, handlePostContacts } from '../index';
import type { Env } from '../types';

const env = { DATABASE_URL: 'postgres://mocked' } as unknown as Env;
const ACCOUNT = 'w1test';

function post(path: string, payload: unknown): Request {
  return new Request(`https://worker.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

const pool = new pg.Pool({ connectionString: process.env['TEST_DATABASE_URL'] ?? '' });

beforeEach(async () => {
  await pool.query('TRUNCATE messages, contacts RESTART IDENTITY');
});

describe('POST /contacts (#97)', () => {
  it('creates a new contact with 0s when is_mutual/is_bot are omitted (was a 500)', async () => {
    const res = await handlePostContacts(
      post('/contacts', { contacts: [{ tg_user_id: '1', username: 'alice', first_name: 'Alice' }] }),
      env,
      ACCOUNT,
    );
    expect(res.status).toBe(200);
    const { rows } = await pool.query<{ is_mutual: number; is_bot: number }>(
      `SELECT is_mutual, is_bot FROM contacts WHERE account_id = $1 AND tg_user_id = '1'`,
      [ACCOUNT],
    );
    expect(rows[0]).toMatchObject({ is_mutual: 0, is_bot: 0 });
  });

  it('keeps a known is_mutual=1 when the batch omits the field (no clobbering)', async () => {
    await pool.query(
      `INSERT INTO contacts (account_id, tg_user_id, is_mutual) VALUES ($1, '2', 1)`,
      [ACCOUNT],
    );
    const res = await handlePostContacts(
      post('/contacts', { contacts: [{ tg_user_id: '2', username: 'bob' }] }),
      env,
      ACCOUNT,
    );
    expect(res.status).toBe(200);
    const { rows } = await pool.query<{ is_mutual: number; username: string }>(
      `SELECT is_mutual, username FROM contacts WHERE tg_user_id = '2'`,
    );
    expect(rows[0]!.is_mutual).toBe(1);
    expect(rows[0]!.username).toBe('bob');
  });

  it('applies an explicit value, including a real 1 -> 0 downgrade', async () => {
    await handlePostContacts(
      post('/contacts', { contacts: [{ tg_user_id: '3', is_mutual: 1, is_bot: 0 }] }),
      env,
      ACCOUNT,
    );
    await handlePostContacts(
      post('/contacts', { contacts: [{ tg_user_id: '3', is_mutual: 0, is_bot: 0 }] }),
      env,
      ACCOUNT,
    );
    const { rows } = await pool.query<{ is_mutual: number }>(
      `SELECT is_mutual FROM contacts WHERE tg_user_id = '3'`,
    );
    expect(rows[0]!.is_mutual).toBe(0);
  });

  it('accepts a duplicate tg_user_id inside one batch, last row wins (was a 500)', async () => {
    const res = await handlePostContacts(
      post('/contacts', {
        contacts: [
          { tg_user_id: '4', username: 'first' },
          { tg_user_id: '4', username: 'second' },
        ],
      }),
      env,
      ACCOUNT,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { upserted: number };
    expect(body.upserted).toBe(1);
    const { rows } = await pool.query<{ username: string }>(
      `SELECT username FROM contacts WHERE tg_user_id = '4'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.username).toBe('second');
  });

  it('reports distinct contacts, not inserted+updated double-counted', async () => {
    const fresh = await handlePostContacts(
      post('/contacts', {
        contacts: [
          { tg_user_id: '5', username: 'x' },
          { tg_user_id: '6', username: 'y' },
        ],
      }),
      env,
      ACCOUNT,
    );
    expect(((await fresh.json()) as { upserted: number }).upserted).toBe(2);

    const repeat = await handlePostContacts(
      post('/contacts', {
        contacts: [
          { tg_user_id: '5', username: 'x' },
          { tg_user_id: '6', username: 'y' },
        ],
      }),
      env,
      ACCOUNT,
    );
    expect(((await repeat.json()) as { upserted: number }).upserted).toBe(2);
  });

  it('rejects a non-string tg_user_id with 400, not a 500', async () => {
    const res = await handlePostContacts(
      post('/contacts', { contacts: [{ tg_user_id: 12345 }] }),
      env,
      ACCOUNT,
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /ingest (#98)', () => {
  const msg = (id: string, text: string) => ({
    tg_message_id: id,
    tg_chat_id: '777',
    message_type: 'text',
    text,
    sent_at: 1700000000,
  });

  it('accepts a duplicate (chat, message) key inside one batch, last text wins (was a 500)', async () => {
    const res = await handleIngest(
      post('/ingest', { messages: [msg('1001', 'first take'), msg('1001', 'edited take')] }),
      env,
      ACCOUNT,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { written: number; noop: number };
    expect(body.written).toBe(1);
    const { rows } = await pool.query<{ text: string }>(
      `SELECT text FROM messages WHERE tg_message_id = '1001'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe('edited take');
  });

  it('writes distinct messages in one batch', async () => {
    const res = await handleIngest(
      post('/ingest', { messages: [msg('1002', 'a'), msg('1003', 'b'), msg('1004', 'c')] }),
      env,
      ACCOUNT,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { written: number };
    expect(body.written).toBe(3);
  });
});
