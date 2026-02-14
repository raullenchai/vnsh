import { defineConfig } from 'vite';
import { resolve } from 'path';

/**
 * Base Vite config. The actual build is done by build.ts which
 * calls vite.build() once per entry point with inlineDynamicImports,
 * ensuring each output file is self-contained.
 *
 * `vite build` (default) uses the multi-entry config below.
 * It works for dev/watch mode. For production, use `npm run build`.
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
