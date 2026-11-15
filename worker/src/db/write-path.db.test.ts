import { beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import process from 'node:process';

// The write-path contract tests (#107 #108 #109) run the REAL handlers
// against a real Postgres, same adapter pattern as the ingest tests.
vi.mock('@neondatabase/serverless', async () => {
  const pgMod = await import('pg');
  const pool = new pgMod.Pool({ connectionString: process.env['TEST_DATABASE_URL'] ?? '' });
  return {
    neon: () => (text: string, params?: unknown[]) =>
      pool.query(text, (params ?? []) as never[]).then(r => {
        // Mirror BOTH neon() call forms: plain calls get the rows array,
        // {fullResults: true} callers read .rowCount off the same object.
        const rows = r.rows as unknown[] & { rowCount?: number };
        rows.rowCount = r.rowCount ?? 0;
        return rows;
      }),
  };
});

import { handleAckAction, handleAckOutbox, handleGetActionsPending, handleGetOutboxDue } from '../index';
import type { Env, OutboxItem } from '../types';

const env = { DATABASE_URL: 'postgres://mocked' } as unknown as Env;
const ACCOUNT = 'w3test';
const NOW = Math.floor(Date.now() / 1000);

const pool = new pg.Pool({ connectionString: process.env['TEST_DATABASE_URL'] ?? '' });

const get = () => new Request('https://worker.test/outbox/due', { headers: { 'X-Ingest-Token': 't' } });
const post = (path: string, payload: unknown) =>
  new Request(`https://worker.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

async function insertOutbox(status: string, updatedAgeSec = 0, withId = false): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO outbox (account_id, tg_chat_id, text, status, updated_at, sent_message_id)
     VALUES ($1, '555', 'hello', $2, $3, $4) RETURNING id`,
    [ACCOUNT, status, NOW - updatedAgeSec, withId ? '424242' : null],
  );
  return rows[0]!.id;
}

beforeEach(async () => {
  await pool.query('TRUNCATE outbox, pending_actions RESTART IDENTITY CASCADE');
});

describe('GET /outbox/due — claim semantics (#107 #108)', () => {
  it('claims pending items exactly once', async () => {
    await insertOutbox('pending');
    await insertOutbox('pending');
    const first = await handleGetOutboxDue(get(), env, ACCOUNT);
    const firstItems = (await first.json()) as OutboxItem[];
    expect(firstItems).toHaveLength(2);
    expect(firstItems.every(i => i.status === 'sending')).toBe(true);

    const second = await handleGetOutboxDue(get(), env, ACCOUNT);
    expect(((await second.json()) as OutboxItem[])).toHaveLength(0);
  });

  it('a stuck claim WITH a sent id is finalized as sent — never re-sent', async () => {
    const id = await insertOutbox('sending', 400, true);
    const res = await handleGetOutboxDue(get(), env, ACCOUNT);
    expect(((await res.json()) as OutboxItem[])).toHaveLength(0); // not re-claimed
    const { rows } = await pool.query<{ status: string }>('SELECT status FROM outbox WHERE id = $1', [id]);
    expect(rows[0]!.status).toBe('sent');
  });

  it('a stuck claim WITHOUT a sent id is parked for review — never auto-retried', async () => {
    const id = await insertOutbox('sending', 400, false);
    const res = await handleGetOutboxDue(get(), env, ACCOUNT);
    expect(((await res.json()) as OutboxItem[])).toHaveLength(0);
    const { rows } = await pool.query<{ status: string; error: string }>(
      'SELECT status, error FROM outbox WHERE id = $1', [id],
    );
    expect(rows[0]!.status).toBe('needs_review');
    expect(rows[0]!.error).toContain('parked');
  });

  it('a fresh claim is left alone', async () => {
    const id = await insertOutbox('sending', 10, false);
    await handleGetOutboxDue(get(), env, ACCOUNT);
    const { rows } = await pool.query<{ status: string }>('SELECT status FROM outbox WHERE id = $1', [id]);
    expect(rows[0]!.status).toBe('sending');
  });
});

describe('POST /outbox/:id/ack (#107 #108)', () => {
  it('records the sent id and finalizes', async () => {
    const id = await insertOutbox('sending');
    const res = await handleAckOutbox(id, post('/ack', { status: 'sent', sent_message_id: '31337' }), env, ACCOUNT);
    expect(res.status).toBe(200);
    const { rows } = await pool.query<{ status: string; sent_message_id: string }>(
      'SELECT status, sent_message_id FROM outbox WHERE id = $1', [id],
    );
    expect(rows[0]).toMatchObject({ status: 'sent', sent_message_id: '31337' });
  });

  it('a progress ack keeps the claim and records per-recipient results with ids', async () => {
    const { rows: outboxRows } = await pool.query<{ id: number }>(
      `INSERT INTO outbox (account_id, text, status) VALUES ($1, 'hi {first_name}', 'sending') RETURNING id`,
      [ACCOUNT],
    );
    const outboxId = outboxRows[0]!.id;
    const { rows: recp } = await pool.query<{ id: number }>(
      `INSERT INTO outbox_recipients (outbox_id, tg_chat_id, status) VALUES ($1, '556', 'pending') RETURNING id`,
      [outboxId],
    );
    const res = await handleAckOutbox(
      outboxId,
      post('/ack', { status: 'sending', results: [{ id: recp[0]!.id, status: 'sent', sent_message_id: '999' }] }),
      env,
      ACCOUNT,
    );
    expect(res.status).toBe(200);
    const { rows: item } = await pool.query<{ status: string }>('SELECT status FROM outbox WHERE id = $1', [outboxId]);
    expect(item[0]!.status).toBe('sending'); // progress never finalizes
    const { rows: r2 } = await pool.query<{ status: string; sent_message_id: string }>(
      'SELECT status, sent_message_id FROM outbox_recipients WHERE id = $1', [recp[0]!.id],
    );
    expect(r2[0]).toMatchObject({ status: 'sent', sent_message_id: '999' });
  });

  it('a terminal ack is rejected when the item is not claimed (precondition)', async () => {
    const id = await insertOutbox('draft');
    const res = await handleAckOutbox(id, post('/ack', { status: 'sent' }), env, ACCOUNT);
    expect(res.status).toBe(409);
  });

  it('an operator can resolve a parked item via terminal ack', async () => {
    const id = await insertOutbox('needs_review');
    const res = await handleAckOutbox(id, post('/ack', { status: 'sent', sent_message_id: '1' }), env, ACCOUNT);
    expect(res.status).toBe(200);
  });
});

describe('concurrent claims — two pollers never get the same row (audit round 1)', () => {
  async function concurrentRounds(claim: () => Promise<number[]>, rounds: number): Promise<number> {
    let overlaps = 0;
    for (let i = 0; i < rounds; i++) {
      const [a, b] = await Promise.all([claim(), claim()]);
      overlaps += a.filter(id => b.includes(id)).length;
    }
    return overlaps;
  }

  it('outbox: overlapping /outbox/due claims are disjoint', async () => {
    for (let i = 0; i < 30; i++) await insertOutbox('pending');
    const claim = async (): Promise<number[]> => {
      const res = await handleGetOutboxDue(get(), env, ACCOUNT);
      return ((await res.json()) as OutboxItem[]).map(i => i.id);
    };
    expect(await concurrentRounds(claim, 8)).toBe(0);
    const { rows } = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'sending'`);
    expect(Number(rows[0]!.n)).toBe(30); // each claimed exactly once overall
  });

  it('actions: overlapping /actions/pending claims are disjoint', async () => {
    for (let i = 0; i < 30; i++) {
      await pool.query(
        `INSERT INTO pending_actions (account_id, action, tg_chat_id, tg_message_id) VALUES ($1, 'edit', '555', $2)`,
        [ACCOUNT, String(1000 + i)],
      );
    }
    const claim = async (): Promise<number[]> => {
      const res = await handleGetActionsPending(get(), env, ACCOUNT);
      return ((await res.json()) as Array<{ id: number }>).map(r => r.id);
    };
    expect(await concurrentRounds(claim, 8)).toBe(0);
    const { rows } = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM pending_actions WHERE status = 'sending'`);
    expect(Number(rows[0]!.n)).toBe(30);
  });
});

describe('mass-send finalize + parked requeue (audit round 1)', () => {
  it('a stuck mass send with ALL recipients terminal auto-finalizes instead of parking', async () => {
    const { rows: o } = await pool.query<{ id: number }>(
      `INSERT INTO outbox (account_id, text, status, updated_at) VALUES ($1, 'hi', 'sending', $2) RETURNING id`,
      [ACCOUNT, NOW - 400],
    );
    const id = o[0]!.id;
    await pool.query(
      `INSERT INTO outbox_recipients (outbox_id, tg_chat_id, status, sent_message_id) VALUES ($1,'556','sent','900'), ($1,'557','failed',NULL)`,
      [id],
    );
    const res = await handleGetOutboxDue(get(), env, ACCOUNT);
    expect(((await res.json()) as OutboxItem[])).toHaveLength(0);
    const { rows } = await pool.query<{ status: string }>('SELECT status FROM outbox WHERE id = $1', [id]);
    expect(rows[0]!.status).toBe('partial'); // mixed sent/failed
  });

  it('a stuck mass send with a pending recipient still parks (undelivered work remains)', async () => {
    const { rows: o } = await pool.query<{ id: number }>(
      `INSERT INTO outbox (account_id, text, status, updated_at) VALUES ($1, 'hi', 'sending', $2) RETURNING id`,
      [ACCOUNT, NOW - 400],
    );
    const id = o[0]!.id;
    await pool.query(
      `INSERT INTO outbox_recipients (outbox_id, tg_chat_id, status) VALUES ($1,'556','sent'), ($1,'557','pending')`,
      [id],
    );
    await handleGetOutboxDue(get(), env, ACCOUNT);
    const { rows } = await pool.query<{ status: string }>('SELECT status FROM outbox WHERE id = $1', [id]);
    expect(rows[0]!.status).toBe('needs_review');
  });

  it('requeue: a parked mass send returns to pending and a fresh claim re-sends ONLY undelivered recipients', async () => {
    const { rows: o } = await pool.query<{ id: number }>(
      `INSERT INTO outbox (account_id, text, status, updated_at) VALUES ($1, 'hi', 'needs_review', $2) RETURNING id`,
      [ACCOUNT, NOW - 400],
    );
    const id = o[0]!.id;
    await pool.query(
      `INSERT INTO outbox_recipients (outbox_id, tg_chat_id, status, sent_message_id)
       VALUES ($1,'556','sent','901'), ($1,'557','pending',NULL)`,
      [id],
    );
    const requeue = await handleAckOutbox(id, post('/ack', { status: 'pending' }), env, ACCOUNT);
    expect(requeue.status).toBe(200);
    const claim = await handleGetOutboxDue(get(), env, ACCOUNT);
    const mine = ((await claim.json()) as OutboxItem[]).find(i => i.id === id);
    expect(mine).toBeDefined();
    expect(mine!.recipients).toHaveLength(1);            // only the pending one
    expect(mine!.recipients![0]!.tg_chat_id).toBe('557');
  });

  it('requeue is refused for a single send with a recorded delivery id', async () => {
    const id = await insertOutbox('needs_review', 0, true);
    const res = await handleAckOutbox(id, post('/ack', { status: 'pending' }), env, ACCOUNT);
    expect(res.status).toBe(409);
  });

  it('requeue is refused for items that are not parked', async () => {
    const id = await insertOutbox('draft');
    const res = await handleAckOutbox(id, post('/ack', { status: 'pending' }), env, ACCOUNT);
    expect(res.status).toBe(409);
  });
});

describe('GET /actions/pending + ack — claim-based handout (#109)', () => {
  interface ActionRow { id: number; action: string; status: string }

  async function insertAction(): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO pending_actions (account_id, action, tg_chat_id, tg_message_id, text)
       VALUES ($1, 'edit', '555', '777', 'edited') RETURNING id`,
      [ACCOUNT],
    );
    return rows[0]!.id;
  }

  it('hands each action out exactly once', async () => {
    const a = await insertAction();
    await insertAction();
    const first = await handleGetActionsPending(get(), env, ACCOUNT);
    const firstRows = (await first.json()) as ActionRow[];
    expect(firstRows).toHaveLength(2);
    const second = await handleGetActionsPending(get(), env, ACCOUNT);
    expect(((await second.json()) as ActionRow[])).toHaveLength(0);
    const { rows } = await pool.query<{ status: string }>('SELECT status FROM pending_actions WHERE id = $1', [a]);
    expect(rows[0]!.status).toBe('sending');
  });

  it('a claim stuck >5 min is parked, never re-handed-out', async () => {
    const id = await insertAction();
    await pool.query(
      `UPDATE pending_actions SET status = 'sending', claimed_at = $1 WHERE id = $2`,
      [NOW - 400, id],
    );
    const res = await handleGetActionsPending(get(), env, ACCOUNT);
    expect(((await res.json()) as ActionRow[])).toHaveLength(0);
    const { rows } = await pool.query<{ status: string }>('SELECT status FROM pending_actions WHERE id = $1', [id]);
    expect(rows[0]!.status).toBe('needs_review');
  });

  it('a fresh claim is left alone; acking from pending is rejected', async () => {
    const id = await insertAction();
    await pool.query(`UPDATE pending_actions SET status = 'sending', claimed_at = $1 WHERE id = $2`, [NOW - 10, id]);
    await handleGetActionsPending(get(), env, ACCOUNT);
    const { rows } = await pool.query<{ status: string }>('SELECT status FROM pending_actions WHERE id = $1', [id]);
    expect(rows[0]!.status).toBe('sending');

    const pendingId = await insertAction();
    const rejected = await handleAckAction(pendingId, post('/ack', { status: 'done' }), env, ACCOUNT);
    expect(rejected.status).toBe(409);

    const ok = await handleAckAction(id, post('/ack', { status: 'done' }), env, ACCOUNT);
    expect(ok.status).toBe(200);
  });

  it('an operator can resolve a parked action', async () => {
    const id = await insertAction();
    await pool.query(`UPDATE pending_actions SET status = 'needs_review' WHERE id = $1`, [id]);
    const res = await handleAckAction(id, post('/ack', { status: 'failed', error: 'reviewed: already applied' }), env, ACCOUNT);
    expect(res.status).toBe(200);
  });
});
