import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text', 'json-summary', 'html'],
      thresholds: { statements: 62.3, branches: 57.9, functions: 84.4, lines: 63.6 },
    },
  },
});
