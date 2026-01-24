import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000, // E2E tests may take longer
    hookTimeout: 10000,
    // Skip E2E tests if no server is running
    // Run with: OPAQUE_HOST=http://localhost:8787 npm test
    env: {
      OPAQUE_HOST: process.env.OPAQUE_HOST || 'http://localhost:8787',
    },
  },
});
