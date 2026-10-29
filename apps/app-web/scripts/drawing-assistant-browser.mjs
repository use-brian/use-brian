// [COMP:doc/drawing-tools] Server shape actions rendered live in two real Excalidraw clients.
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const syncRequire = createRequire(new URL('../../doc-sync/package.json', import.meta.url));
const { Server } = await import(pathToFileURL(syncRequire.resolve('@hocuspocus/server').replace(/hocuspocus-server\.cjs$/, 'hocuspocus-server.esm.js')).href);
import { resolveCollabSingletonAliases } from '../../../scripts/collab-singletons.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = fileURLToPath(new URL('..', import.meta.url));
const cache = await mkdtemp(join(tmpdir(), 'brian-drawing-assistant-'));
const server = await createServer({ configFile: false, root: app, cacheDir: cache,
  define: { 'process.env': '{}' }, publicDir: join(app, 'public'),
  plugins: [react(), tailwind()], css: { postcss: { plugins: [] } },
  resolve: { alias: [{ find: '@', replacement: join(app, 'src') },
    ...Object.entries(resolveCollabSingletonAliases(new URL('../package.json', import.meta.url))).map(([find, replacement]) => ({ find, replacement })),
    { find: '@use-brian/shared/drawing', replacement: resolve(app, '../../packages/shared/src/drawing.ts') }] },
  server: { port: 0, host: '127.0.0.1', hmr: false, fs: { allow: [resolve(app, '../../..'), cache] } } });
server.middlewares.stack.unshift({ route: '', handle: (req, _res, next) => {
  if (req.url.startsWith('/w/')) req.url = '/scripts/fixtures/drawing-library-browser.html';
  next();
} });
let browser;
let assistantSocket;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  const errors = [];
  const [saved, observer] = await Promise.all([browser.newPage({ viewport: { width: 1200, height: 900 } }), browser.newPage({ viewport: { width: 1200, height: 900 } })]);
  for (const page of [saved, observer]) {
    page.setDefaultTimeout(30_000);
    await page.goto(`http://localhost:${server.httpServer.address().port}/w/workspace/p/page?live=1&seed=1`);
    await page.getByRole('button', { name: 'Edit drawing', exact: true }).click();
    await page.waitForFunction(() => window.h?.app?.getSceneElements().length === 1);
  }
  const snapshot = page => page.evaluate(() => window.drawingTest.snapshot());
  const elements = page => page.evaluate(() => window.h.app.getSceneElements().map(e => ({ id: e.id, type: e.type, x: e.x, y: e.y, width: e.width, height: e.height })));
  // Assistant actions originate on the server, then travel over real WebSockets
  // into mounted SDKs. No page reload, scene replacement or browser Save.
  const { applyOpsToYDoc } = await import('../../../packages/doc-model/dist/index.js');
  const { defaultDrawingLibrary } = await import('../../../packages/shared/dist/drawing.js');
  assistantSocket = new Server({ port: 0, address: '127.0.0.1', quiet: true, stopOnSignals: false });
  await assistantSocket.listen();
  for (const page of [saved, observer]) {
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(url => window.drawingTest.connect(url), `ws://127.0.0.1:${assistantSocket.address.port}`);
    await page.waitForFunction(() => window.drawingProvider.synced);
  }
  const connection = await assistantSocket.hocuspocus.openDirectConnection('drawing-test');
  try {
    let namespace;
    await connection.transact(doc => {
      namespace = applyOpsToYDoc(doc, [{ op: 'drawing', blockId: 'drawing', actions: [] }]).drawings.drawing.namespace;
    });
    let insertedId;
    const item = defaultDrawingLibrary()[0];
    await connection.transact(doc => {
      const result = applyOpsToYDoc(doc, [{ op: 'drawing', blockId: 'drawing', namespace, actions: [
        { type: 'move', elementIds: ['saved-shape'], dx: 100, dy: 60 },
        { type: 'resize', elementId: 'saved-shape', width: 180, height: 100 },
        { type: 'insertLibraryItem', item, x: 500, y: 200 },
      ] }]);
      assert.deepEqual(result.skipped, []);
      insertedId = result.drawings.drawing.changedElementIds.find(id => id !== 'saved-shape');
    });
    await connection.transact(doc => {
      assert.deepEqual(applyOpsToYDoc(doc, [{ op: 'drawing', blockId: 'drawing', namespace,
        actions: [{ type: 'connect', fromId: 'saved-shape', toId: insertedId }] }]).skipped, []);
    });
    for (const page of [saved, observer]) {
      await page.waitForFunction(count => window.h.app.getSceneElements().length === count, item.elements.length + 2);
      await page.waitForFunction(() => {
        const elements = window.h.app.getSceneElements();
        const shape = elements.find(e => e.id === 'saved-shape');
        return shape?.x === 120 && shape.y === 80 && shape.width === 180 && shape.height === 100 &&
          elements.some(e => e.type === 'arrow' && e.startBinding?.elementId === 'saved-shape');
      });
      assert.equal(await page.getByRole('button', { name: 'Close', exact: true }).isVisible(), true);
    }
    assert.deepEqual(await elements(saved), await elements(observer));
    assert.deepEqual((await snapshot(saved)).page, (await snapshot(observer)).page);
    await saved.waitForTimeout(1800); // Derived PNG may write; geometry must not.
    assert.equal((await snapshot(saved)).page.blocks[0].scene.elements.find(e => e.id === 'saved-shape').x, 120);
    console.log('PASS server assistant move/resize/connect/library insertion appear live in two mounted SDKs');
  } finally { await connection.disconnect(); }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await assistantSocket?.destroy();
  await server.close();
  await rm(cache, { recursive: true, force: true });
}
