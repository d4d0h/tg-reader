import { defineConfig } from 'vitest/config';

// Database tests — require TEST_DATABASE_URL pointing at a real Postgres with
// rights to create/drop data (CI provisions postgres:16 and the global setup
// loads schema.sql, which is idempotent). Run with: npm run test:db
export default defineConfig({
  test: {
    include: ['src/**/*.db.test.ts'],
    environment: 'node',
    globalSetup: ['./vitest.db.global-setup.ts'],
  },
});
