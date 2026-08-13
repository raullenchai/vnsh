import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text', 'json-summary', 'html'],
      thresholds: { statements: 44, branches: 29.4, functions: 61.9, lines: 45.6 },
    },
  },
});
