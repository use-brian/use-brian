// [COMP:app-web/channel-recordings] Real controls and styles with synthetic recovery endpoints.
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { resolveCollabSingletonAliases } from '../../../scripts/collab-singletons.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = fileURLToPath(new URL('..', import.meta.url));
const cache = await mkdtemp(join(tmpdir(), 'channel-recovery-vite-'));
const output = process.env.CHANNEL_RECOVERY_OUTPUT || join(tmpdir(), 'channel-recovery-browser');
await mkdir(output, { recursive: true });
const transport = join(app, 'scripts/fixtures/channel-recovery-browser-transport.tsx');
const server = await createServer({ configFile: false, envFile: false, root: app, cacheDir: cache,
  plugins: [react(), tailwind()], optimizeDeps: { entries: ['scripts/fixtures/channel-recovery-browser.html'] }, css: { postcss: { plugins: [] } }, define: { 'process.env': '{}' },
  resolve: { dedupe: ['react', 'react-dom'], alias: [
    ...['next/navigation', 'next/link', '@/lib/auth-fetch', './auth-fetch'].map(find => ({ find, replacement: transport })),
    { find: '@', replacement: join(app, 'src') },
    ...Object.entries(resolveCollabSingletonAliases(new URL('../package.json', import.meta.url))).map(([find, replacement]) => ({ find, replacement })),
  ] }, server: { port: 0, host: '127.0.0.1', hmr: false, fs: { allow: [resolve(app, '../../..'), cache] } } });

let browser;
const errors = [];
const results = [];
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(20_000);
  const url = `http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/channel-recovery-browser.html`;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(url);
    const review = page.getByRole('button', { name: 'Review group context', exact: true });
    await review.waitFor();
    assert.equal(await page.evaluate(() => window.recoveryFixture.requests.some(r => r.path.endsWith('/legacy-recovery'))), false);
    await review.click();
    await page.getByText('Weekly team planning', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(output, `preview-${width}.png`), fullPage: true });
    const restore = page.getByRole('button', { name: 'Restore group context', exact: true });
    if (width === 390) assert.ok((await restore.boundingBox()).height >= 44);
    await restore.click();
    let dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('[role="alertdialog"]')].some(el => getComputedStyle(el).opacity === "1"));
    await page.screenshot({ path: join(output, `confirm-${width}.png`), fullPage: true });
    assert.equal(await dialog.evaluate(el => el.scrollWidth > el.clientWidth), false);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.evaluate(() => window.recoveryFixture.requests.filter(r => r.method === 'POST').length), 0);
    await page.evaluate(() => { window.recoveryFixture.fixture.pending = true; });
    await restore.click();
    dialog = page.getByRole('alertdialog');
    await dialog.getByRole('button', { name: 'Restore group context', exact: true }).click();
    assert.equal(await review.isDisabled(), true);
    await page.getByRole('status').getByText(/Group context restored/).waitFor();
    assert.deepEqual(await page.evaluate(() => window.recoveryFixture.requests.find(r => r.method === 'POST').body), { sessionId: 'original-session', snapshotToken: 'reviewed-snapshot', confirmConnectedByMe: true, confirmHistoryReview: true });
    await review.click();
    await page.getByText('No earlier shared group context is available to restore.', { exact: true }).waitFor();
    results.push({ width, reviewedMetadata: true, explicitConfirmation: true, restored: true, refreshed: true });
  }
  await page.reload();
  await page.getByRole('button', { name: 'Review group context', exact: true }).click();
  await page.evaluate(() => { window.recoveryFixture.fixture.fail = true; });
  await page.getByRole('button', { name: 'Restore group context', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Restore group context', exact: true }).click();
  await page.getByRole('alert').getByText(/Could not confirm recovery/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Restore group context', exact: true }).count(), 0);
  await page.screenshot({ path: join(output, 'stale-390.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'results.json'), JSON.stringify({ results, staleRecovery: true, errors }, null, 2));
  console.log(JSON.stringify({ output, results, staleRecovery: true }));
} finally {
  await browser?.close(); await server.close(); await rm(cache, { recursive: true, force: true });
}
