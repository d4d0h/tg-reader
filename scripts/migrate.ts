/**
 * CLI runner for schema migrations (single source of statements:
 * worker/src/migrations.ts).
 *
 *   DATABASE_URL=postgres://... npm run migrate
 *
 * The same migrations can be applied through the deployed Worker via
 * POST /admin/migrate (x-admin-token header) when no local database URL is
 * at hand — the Worker runs them with its own DATABASE_URL.
 */

import { Pool } from 'pg';
import { MIGRATIONS, applyMigrations } from '../worker/src/migrations';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL must point at the archive database (same value the Worker uses) — ' +
        'or POST /admin/migrate on the deployed Worker with the admin token.',
    );
  }
  // Neon and other hosted URLs carry sslmode=require (or a neon host); local
  // Postgres does not support SSL — let the connection string decide.
  const needsSsl = /sslmode=require|neon\.(tech|build)/.test(url);
  const pool = new Pool({
    connectionString: url,
    ...(needsSsl ? { ssl: { rejectUnauthorized: true } } : {}),
  });
  try {
    const log = await applyMigrations(
      async (text: string, params?: unknown[]) => {
        const r = await pool.query(text, (params ?? []) as never[]);
        return r.rows;
      },
      // Each migration runs in one transaction (the pg driver supports it).
      async () => { await pool.query('BEGIN'); },
      async () => { await pool.query('COMMIT'); },
      async () => { await pool.query('ROLLBACK'); },
    );
    for (const line of log) console.log(line);
    console.log(`migrations up to date (${MIGRATIONS.length} known)`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('migration failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
