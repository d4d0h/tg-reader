import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';

// Baseline schema-behaviour tests against a real Postgres (CI service
// container; locally: docker run -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16).
// These pin the database behaviours the ingest fixes rely on:
//   - contacts.is_mutual is NOT NULL DEFAULT 0 and an explicit NULL violates it
//   - message upserts are idempotent across statements
//   - a duplicate conflict key inside ONE statement aborts it (error 21000)
//   - the search_vector generated column is populated
import process from 'node:process';

const url = process.env['TEST_DATABASE_URL'] ?? '';
const pool = new pg.Pool({ connectionString: url });

beforeAll(() => {
  // globalSetup (vitest.db.global-setup.ts) has already loaded schema.sql.
  if (!url) throw new Error('TEST_DATABASE_URL is not set');
});

beforeEach(async () => {
  await pool.query('TRUNCATE messages, contacts RESTART IDENTITY');
});

describe('contacts defaults', () => {
  it('omitting is_mutual stores the default 0', async () => {
    await pool.query(
      `INSERT INTO contacts (account_id, tg_user_id) VALUES ('primary', '100')`,
    );
    const { rows } = await pool.query<{ is_mutual: number }>(
      `SELECT is_mutual FROM contacts WHERE tg_user_id = '100'`,
    );
    expect(rows[0]!.is_mutual).toBe(0);
  });

  it('an explicit NULL violates NOT NULL (root cause of the /contacts 500)', async () => {
    await expect(
      pool.query(
        `INSERT INTO contacts (account_id, tg_user_id, is_mutual) VALUES ('primary', '101', NULL)`,
      ),
    ).rejects.toMatchObject({ code: '23502' });
  });
});

describe('messages upsert semantics', () => {
  const insert = `
    INSERT INTO messages (account_id, tg_chat_id, tg_message_id, text, sent_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (account_id, tg_chat_id, tg_message_id) DO UPDATE SET text = EXCLUDED.text
  `;

  it('is idempotent across statements', async () => {
    await pool.query(insert, ['primary', '200', '1', 'first', 100]);
    await pool.query(insert, ['primary', '200', '1', 'edited', 100]);
    const { rows } = await pool.query<{ text: string; count: string }>(
      `SELECT text, COUNT(*) OVER () AS count FROM messages WHERE tg_chat_id = '200'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe('edited');
  });

  it('a duplicate conflict key inside one statement aborts it with 21000 (root cause of the /ingest 500)', async () => {
    // Two rows with the same (account_id, tg_chat_id, tg_message_id) in a single
    // INSERT ... SELECT, exactly like an undeduped UNNEST batch.
    await expect(
      pool.query(`
        INSERT INTO messages (account_id, tg_chat_id, tg_message_id, text, sent_at)
        SELECT * FROM (VALUES
          ('primary', '201', '1', 'first', 100),
          ('primary', '201', '1', 'second', 100)
        ) AS v(account_id, tg_chat_id, tg_message_id, text, sent_at)
        ON CONFLICT (account_id, tg_chat_id, tg_message_id) DO UPDATE SET text = EXCLUDED.text
      `),
    ).rejects.toMatchObject({ code: '21000' });
  });
});

describe('search_vector', () => {
  it('is generated from the message text and queryable', async () => {
    await pool.query(
      `INSERT INTO messages (account_id, tg_chat_id, tg_message_id, text, sent_at)
       VALUES ('primary', '202', '1', 'hello zqxpathfinder world', 100)`,
    );
    const { rows } = await pool.query<{ tg_message_id: string }>(
      `SELECT tg_message_id FROM messages WHERE search_vector @@ to_tsquery('simple', 'zqxpathfinder')`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tg_message_id).toBe('1');
  });
});
