// [COMP:app-web/workflow-detail-cache] Real page, CSS and controls; synthetic API.
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
const cache = await mkdtemp(join(tmpdir(), 'workflow-page-vite-'));
const output = process.env.WORKFLOW_PAGE_OUTPUT || join(tmpdir(), 'workflow-page-browser');
await mkdir(output, { recursive: true });
const transport = join(app, 'scripts/fixtures/workflow-page-browser-transport.tsx');
const server = await createServer({ configFile: false, envFile: false, root: app, cacheDir: cache,
  plugins: [react(), tailwind()], optimizeDeps: { entries: ['scripts/fixtures/workflow-page-browser.html'] }, css: { postcss: { plugins: [] } }, define: { 'process.env': '{}' },
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
  page.on('pageerror', error => { errors.push(error.message); console.error('PAGE:', error.message); });
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  page.setDefaultTimeout(30_000);
  const url = `http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/workflow-page-browser.html`;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url);
    const trigger = page.locator(width < 768 ? '[data-workflow-mobile-step="trigger"]' : '[data-node-key="__trigger"]');
    await trigger.waitFor();
    await page.getByText('Checking delivery permissions', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await page.getByText('Workflow context', { exact: true }).count(), 0);
    const board = await trigger.boundingBox();
    assert.ok(board.y < 600, 'Trigger must be visible in the first viewport');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(output, `flow-${width}.png`) });
    await page.getByRole('tab', { name: 'Flow', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await page.getByText('Recent runs', { exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Settings', exact: true }).click();
    await page.getByText('Workflow context', { exact: true }).waitFor();
    await page.getByText('Routine work intake', { exact: true }).waitFor();
    await page.screenshot({ path: join(output, `settings-${width}.png`) });
    await page.getByRole('tab', { name: 'Runs', exact: true }).click();
    await page.getByText('Recent runs', { exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Flow', exact: true }).click();
    assert.equal(await page.getByText('Workflow context', { exact: true }).isVisible(), false);
    if (width < 768) {
      await page.getByRole('button', { name: 'Show connections', exact: true }).click();
      await page.locator('[data-node-key="__trigger"]').waitFor();
      await page.getByRole('button', { name: 'Hide connections', exact: true }).click();
    }
    await page.locator(width < 768 ? '[data-workflow-mobile-step="read"]' : '[data-node-key="read"]').click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    const input = dialog.locator('input[maxlength="200"]');
    await input.fill('Read the new enquiry');
    await page.screenshot({ path: join(output, `inspector-${width}.png`) });
    assert.equal(await dialog.evaluate(el => el.scrollWidth > el.clientWidth), false);
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('tab', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Flow', exact: true }).click();
    assert.ok(await page.getByText('Read the new enquiry', { exact: true }).first().count());
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByText('Saved', { exact: true }).waitFor();
    results.push({ width, flowVisible: true, tabs: true, inspector: true, draftSaved: true });
  }
  // Reproduce a request that never resolves. Retry must release the shared cache slot.
  await page.evaluate(() => { window.workflowFixture.fixture.consent = 'hang'; window.workflowFixture.refresh(); });
  await page.getByText('Delivery permissions could not be checked.', { exact: true }).waitFor({ timeout: 16_000 });
  await page.screenshot({ path: join(output, 'consent-timeout.png') });
  await page.evaluate(() => { window.workflowFixture.fixture.consent = 'eligible'; });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('button', { name: 'Review permissions', exact: true }).click();
  await page.getByRole('dialog').getByText('Prepared-output publication', { exact: true }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Approve', exact: true }).click();
  const confirmation = page.getByRole('alertdialog');
  await confirmation.waitFor();
  assert.ok(await confirmation.getByText(/private information/).count());
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.evaluate(() => window.workflowFixture.requests.filter(request => request.path.endsWith('/publication-consent') && request.method === 'POST').length), 0);
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'results.json'), JSON.stringify({ results, timeoutRecovery: true, errors }, null, 2));
  console.log(JSON.stringify({ output, results, timeoutRecovery: true }));
} finally {
  await browser?.close(); await server.close(); await rm(cache, { recursive: true, force: true });
}
