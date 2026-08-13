import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'istanbul',
      include: ['src/lib/**/*.ts'],
      reporter: ['text', 'json-summary', 'html'],
      thresholds: { statements: 89.9, branches: 70, functions: 95.7, lines: 89.9 },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
