import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Loads the (idempotent) schema into the test database once per run.
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
}
