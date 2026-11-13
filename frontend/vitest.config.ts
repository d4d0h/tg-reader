import { defineConfig } from 'vitest/config';

// jsdom is needed for sessionStorage in api.ts; component tests (wave 5)
// will add the preact jsx settings here when they arrive.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
