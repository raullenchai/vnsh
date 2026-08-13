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
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'test/'],
    },
  },
});
