// ---------------------------------------------------------------------------
// Schema migrations — the single source of truth for upgrading existing
// databases. Consumed by BOTH the admin endpoint (worker/src/index.ts
// POST /admin/migrate — runs with the Worker's own DATABASE_URL) and the CLI
// runner (scripts/migrate.ts — `npm run migrate` with a DATABASE_URL).
//
// Rules (#110): additive columns only; CHECK-constraint swaps via DROP +
// ADD NOT VALID + VALIDATE so large tables never take a long lock; every
// statement guarded so re-running is a no-op; each migration recorded in
// schema_migrations inside one transaction.
// ---------------------------------------------------------------------------

export interface Migration {
  name: string;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
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

// Minimal executor shared by both entry points. `begin/commit/rollback` let
// the CLI wrap each migration in a transaction; the neon HTTP driver the
// Worker uses has no multi-statement transactions, so the endpoint relies on
// the statements' own idempotency guards instead (re-running is a no-op).
export async function applyMigrations(
  query: (text: string, params?: unknown[]) => Promise<unknown>,
  begin?: () => Promise<void>,
  commit?: () => Promise<void>,
  rollback?: () => Promise<void>,
): Promise<string[]> {
  const log: string[] = [];
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name    TEXT PRIMARY KEY,
      applied_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    )
  `);
  const appliedRows = (await query('SELECT name FROM schema_migrations')) as Array<{ name: string }>;
  const applied = new Set(appliedRows.map(r => r.name));

  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) {
      log.push(`= ${m.name} (already applied)`);
      continue;
    }
    if (begin) await begin();
    try {
      for (const stmt of m.statements) {
        await query(stmt);
      }
      await query('INSERT INTO schema_migrations (name) VALUES ($1)', [m.name]);
      if (commit) await commit();
      log.push(`< ${m.name} applied (${m.statements.length} statements)`);
    } catch (err) {
      if (rollback) await rollback();
      throw err;
    }
  }
  return log;
}
