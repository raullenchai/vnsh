import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Native rate-limit bindings are intentionally omitted from the test
      // config: Miniflare implements their shared counters, which would make a
      // unit suite rate-limit itself instead of exercising route behavior.
      wrangler: { configPath: './wrangler.test.toml' },
      miniflare: { r2Buckets: ['VNSH_STORE'], d1Databases: ['ACCOUNTS'] },
    }),
  ],
  test: {
    globals: true,
    coverage: {
      // Cloudflare's Workers pool cannot use native V8 coverage. Istanbul
      // instruments the module before workerd evaluates it and is the provider
      // Cloudflare documents for this integration.
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary', 'html'],
      exclude: ['node_modules/', 'test/'],
      thresholds: { statements: 76.7, branches: 72.2, functions: 92, lines: 79.2 },
    },
  },
});
