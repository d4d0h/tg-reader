import { defineConfig } from 'vitest/config';

// Unit tests — no database. Database-behaviour tests live in *.db.test.ts and
// run under vitest.db.config.ts against a real Postgres (CI service container).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.db.test.ts'],
    environment: 'node',
  },
});
