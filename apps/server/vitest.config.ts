import { defineConfig } from 'vitest/config';

/**
 * Integration tests drive real WebSocket clients through full match phases
 * (countdown, combat, results), so they need a longer timeout than unit tests.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 20_000,
  },
});
