/**
 * Idempotent schema migrations for existing tg-reader databases.
 *
 * Run before merging/deploying the wave that needs it:
 *   DATABASE_URL=postgres://... npm run migrate
 *
 * Rules (wave 3 / #110):
 *  - additive columns only (nullable / defaulted) — old code keeps working
 *    whether or not the migration has run;
 *  - CHECK-constraint changes are NOT purely additive: the old constraint is
 *    dropped and replaced (NOT VALID, then VALIDATE) so the table never takes
 *    a long lock on large tables;
 *  - every statement is guarded so running the script twice is a no-op.
 */

import { Pool } from 'pg';

interface Migration {
  name: string;
  statements: string[];
}

const MIGRATIONS: Migration[] = [
  {
    name: '2026-11-15-write-path',
    statements: [
      // #107: sent-message ids on outbox + per-recipient rows
      `ALTER TABLE outbox ADD COLUMN IF NOT EXISTS sent_message_id TEXT`,
      `ALTER TABLE outbox_recipients ADD COLUMN IF NOT EXISTS sent_message_id TEXT`,
      // #109: claim bookkeeping on pending actions
      `ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS claimed_at BIGINT`,
      // outbox.status gains 'needs_review' (stuck claims are parked, never retried)
      `DO $$
       BEGIN
         IF EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conname = 'outbox_status_check' AND conrelid = 'outbox'::regclass
         ) AND NOT EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conname = 'outbox_status_check_w3' AND conrelid = 'outbox'::regclass
         ) THEN
           ALTER TABLE outbox DROP CONSTRAINT outbox_status_check;
           ALTER TABLE outbox ADD CONSTRAINT outbox_status_check_w3
             CHECK(status IN ('draft','scheduled','pending','sending','sent','failed','partial','needs_review'))
             NOT VALID;
         END IF;
       END $$;`,
      `ALTER TABLE outbox VALIDATE CONSTRAINT outbox_status_check_w3`,
      // pending_actions.status gains 'sending' (claim) and 'needs_review' (stuck claim)
      `DO $$
       BEGIN
         IF EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conname = 'pending_actions_status_check' AND conrelid = 'pending_actions'::regclass
         ) AND NOT EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conname = 'pending_actions_status_check_w3' AND conrelid = 'pending_actions'::regclass
         ) THEN
           ALTER TABLE pending_actions DROP CONSTRAINT pending_actions_status_check;
           ALTER TABLE pending_actions ADD CONSTRAINT pending_actions_status_check_w3
             CHECK(status IN ('pending','sending','done','failed','needs_review'))
             NOT VALID;
         END IF;
       END $$;`,
      `ALTER TABLE pending_actions VALIDATE CONSTRAINT pending_actions_status_check_w3`,
    ],
  },
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL must point at the archive database (same value the Worker uses)');
  }
  // Neon and other hosted URLs carry sslmode=require (or a neon host); local
  // Postgres does not support SSL — let the connection string decide.
  const needsSsl = /sslmode=require|neon\.(tech|build)/.test(url);
  const pool = new Pool({
    connectionString: url,
    ...(needsSsl ? { ssl: { rejectUnauthorized: true } } : {}),
  });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name    TEXT PRIMARY KEY,
        applied_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
      )
    `);
    const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map(r => r.name));

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.name)) {
        console.log(`= ${migration.name} (already applied)`);
        continue;
      }
      console.log(`> applying ${migration.name} (${migration.statements.length} statements)`);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const stmt of migration.statements) {
          await client.query(stmt);
        }
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [migration.name]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      console.log(`< ${migration.name} applied`);
    }
    console.log('migrations up to date');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('migration failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
