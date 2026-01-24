import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000, // E2E tests may take longer
    hookTimeout: 10000,
    // Skip E2E tests if no server is running
    // Run with: VNSH_HOST=http://localhost:8787 npm test
    env: {
      VNSH_HOST: process.env.VNSH_HOST || 'http://localhost:8787',
    },
  },
});
