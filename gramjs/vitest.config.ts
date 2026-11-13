import { defineConfig } from 'vitest/config';

// Node-environment tests for pure helper logic. listener.ts is not imported
// here: it connects to Telegram at import time (extraction lands in wave 2).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
