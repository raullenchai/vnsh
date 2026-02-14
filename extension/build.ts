/**
 * Build script for vnsh Chrome Extension.
 *
 * Builds each entry point independently using vite.build() with
 * inlineDynamicImports: true, so every output file is self-contained
 * (no shared chunks, no ES module imports between files).
 *
 * This is necessary because:
 * - Content scripts can't import ES modules
 * - Service workers need all code in one file
 * - Chrome extension CSP restricts cross-file imports
 */

import { build } from 'vite';
import { resolve } from 'path';
import { cpSync, rmSync, mkdirSync, existsSync } from 'fs';

const root = resolve(import.meta.dirname);
const dist = resolve(root, 'dist');

interface Entry {
  name: string;
  input: string;
  outDir: string; // relative to dist
}

const entries: Entry[] = [
  {
    name: 'service-worker',
    input: 'src/background/service-worker.ts',
    outDir: 'background',
  },
  {
    name: 'detector',
    input: 'src/content/detector.ts',
    outDir: 'content',
  },
  {
    name: 'popup',
    input: 'src/popup/popup.ts',
    outDir: 'popup',
  },
  {
    name: 'offscreen',
    input: 'src/offscreen/offscreen.ts',
    outDir: 'offscreen',
  },
  {
    name: 'onboarding',
    input: 'src/onboarding/onboarding.ts',
    outDir: 'onboarding',
  },
];

async function main() {
  // Clean dist
  if (existsSync(dist)) {
    rmSync(dist, { recursive: true });
  }
  mkdirSync(dist, { recursive: true });

  // Build each entry point independently
  for (const entry of entries) {
    console.log(`\n> Building ${entry.name}...`);
    await build({
      configFile: false,
      root,
      resolve: {
        alias: {
          '@': resolve(root, 'src'),
        },
      },
      build: {
        outDir: resolve(dist, entry.outDir),
        emptyOutDir: false,
        minify: false,
        sourcemap: true,
        rollupOptions: {
          input: resolve(root, entry.input),
          output: {
            format: 'iife',
            name: entry.name.replace(/-/g, '_'),
            entryFileNames: `${entry.name}.js`,
            inlineDynamicImports: true,
          },
        },
      },
      logLevel: 'warn',
    });
  }

  // Copy static assets
  console.log('\n> Copying static assets...');

  // manifest.json
  cpSync(resolve(root, 'manifest.json'), resolve(dist, 'manifest.json'));

  // Icons
  const assetsDir = resolve(dist, 'assets');
  mkdirSync(assetsDir, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    cpSync(
      resolve(root, `src/assets/icon-${size}.png`),
      resolve(assetsDir, `icon-${size}.png`),
    );
  }

  // HTML files
  cpSync(resolve(root, 'src/popup/popup.html'), resolve(dist, 'popup/popup.html'));
  cpSync(resolve(root, 'src/popup/popup.css'), resolve(dist, 'popup/popup.css'));
  cpSync(resolve(root, 'src/offscreen/offscreen.html'), resolve(dist, 'offscreen/offscreen.html'));
  cpSync(resolve(root, 'src/onboarding/onboarding.html'), resolve(dist, 'onboarding/onboarding.html'));
  cpSync(resolve(root, 'src/onboarding/onboarding.css'), resolve(dist, 'onboarding/onboarding.css'));
  cpSync(resolve(root, 'src/content/detector.css'), resolve(dist, 'content/detector.css'));

  console.log('\n✓ Build complete! Output in dist/');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
