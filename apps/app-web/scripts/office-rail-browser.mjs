// [COMP:app-web/office-presentation-editor] Native scroll geometry in Chromium.
import { createServer } from 'vite';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = fileURLToPath(new URL('..', import.meta.url));
const cache = await mkdtemp(resolve(tmpdir(), 'office-rail-browser-'));
const server = await createServer({ configFile: false, envFile: false, root: app, cacheDir: cache,
  plugins: [tailwind()], css: { postcss: { plugins: [] } },
  define: { 'process.env': '{}' }, esbuild: { jsx: 'automatic' },
  resolve: { dedupe: ['react', 'react-dom'], alias: { '@': resolve(app, 'src') } },
  server: { port: 0, host: '127.0.0.1', hmr: false, fs: { allow: [resolve(app, '../..'), cache] } } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/office-rail-browser.html`);
  const rail = page.locator('[data-slide-rail]'); await rail.waitFor();
  const desktop = await rail.evaluate(el => ({ height: el.clientHeight, content: el.scrollHeight, overflow: getComputedStyle(el).overflowY }));
  assert(desktop.height > 0 && desktop.height < 720 && desktop.content > desktop.height, JSON.stringify(desktop));
  await rail.hover(); await page.mouse.wheel(0, 420); await page.waitForFunction(() => document.querySelector('[data-slide-rail]').scrollTop > 0);
  await page.screenshot({ path: resolve(tmpdir(), 'office-rail-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  const phone = await rail.evaluate(el => ({ width: el.clientWidth, content: el.scrollWidth, touch: getComputedStyle(el.querySelector('button')).touchAction }));
  assert(phone.width > 0 && phone.content > phone.width && phone.touch === 'pan-x', JSON.stringify(phone));
  await page.screenshot({ path: resolve(tmpdir(), 'office-rail-phone.png') });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ desktop, phone, nativeWheelScroll: true }));
} finally { await browser?.close(); await server.close(); await rm(cache, { recursive: true, force: true }); }
