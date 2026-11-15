import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Loads the (idempotent) schema into the test database once per run, then
// applies the real migrations — so an existing test database follows the same
// upgrade path (schema.sql for fresh installs + scripts/migrate.ts) that
// production does.
export default async function setup(): Promise<void> {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) {
    throw new Error('TEST_DATABASE_URL must be set for database tests (e.g. postgres://postgres:postgres@localhost:5432/tg_test)');
  }
  const pool = new pg.Pool({ connectionString: url });
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const schema = readFileSync(resolve(here, '..', 'schema.sql'), 'utf8');
    await pool.query(schema);
  } finally {
    await pool.end();
  }
  // Bring an existing database up to date via the real migration script.
  const { execFile } = await import('node:child_process');
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  await new Promise<void>((resolvePromise, reject) => {
    execFile('npm', ['run', 'migrate'], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: url },
    }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`migration failed in global setup: ${stderr}`));
      else resolvePromise();
    });
  });
}
