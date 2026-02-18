/**
 * Generate Chrome Web Store assets using Puppeteer.
 * Run: node store-assets/generate.mjs
 */
import puppeteer from 'puppeteer';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const assetsDir = __dirname;

async function capture(browser, htmlFile, outputFile, width, height) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.goto(`file://${resolve(assetsDir, htmlFile)}`, { waitUntil: 'networkidle0' });
  await page.screenshot({ path: resolve(assetsDir, outputFile), type: 'png', fullPage: false });
  await page.close();
  console.log(`  ${outputFile} (${width}x${height})`);
}

async function main() {
  console.log('Generating Chrome Web Store assets...\n');

  const browser = await puppeteer.launch({ headless: true });

  // Store icon 128x128
  await capture(browser, 'icon-128.html', 'icon-128.png', 128, 128);

  // Screenshot 1280x800
  await capture(browser, 'screenshot-1280x800.html', 'screenshot-1280x800.png', 1280, 800);

  // Small promo tile 440x280
  await capture(browser, 'promo-440x280.html', 'promo-440x280.png', 440, 280);

  // Marquee promo 1400x560 (required for Featured badge)
  await capture(browser, 'marquee-1400x560.html', 'marquee-1400x560.png', 1400, 560);

  await browser.close();
  console.log('\nDone! Files in store-assets/');
}

main().catch(console.error);
