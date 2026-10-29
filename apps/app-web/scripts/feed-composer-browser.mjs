// [COMP:app-web/feed-tuning-chat] Real-layout regression for every Feed composer
// host. Run with PLAYWRIGHT_MODULE when Playwright is installed externally.
// Uses the production component, primitives, globals.css and SSE handler with
// an in-memory authenticated transport. No real account, API or model call.
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { resolveCollabSingletonAliases } from '../../../scripts/collab-singletons.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = fileURLToPath(new URL('..', import.meta.url));
const cache = await mkdtemp(join(tmpdir(), 'brian-feed-composer-'));
const output = process.env.FEED_COMPOSER_OUTPUT || join(tmpdir(), 'feed-composer-browser');
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, envFile: false, root: app, cacheDir: cache,
  plugins: [react(), tailwind()], css: { postcss: { plugins: [] } }, define: { 'process.env': '{}' },
  resolve: { dedupe: ['react', 'react-dom'], alias: [
    { find: '@/lib/auth-fetch', replacement: join(app, 'scripts/fixtures/feed-composer-network.ts') },
    { find: './auth-fetch', replacement: join(app, 'scripts/fixtures/feed-composer-network.ts') },
    { find: '@', replacement: join(app, 'src') },
    ...Object.entries(resolveCollabSingletonAliases(new URL('../package.json', import.meta.url))).map(([find, replacement]) => ({ find, replacement })),
  ] }, server: { port: 0, host: '127.0.0.1', hmr: false, fs: { allow: [resolve(app, '../../..'), cache] } } });
let browser;
const results = [];
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  const context = await browser.newContext();
  await context.addInitScript(() => {
    localStorage.setItem('feed-chat-model', 'standard');
    localStorage.setItem('feed-chat-model-pro-default-migrated', '1');
  });
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  page.setDefaultTimeout(30_000);
  async function measure(name, phone, streaming) {
    const row = await page.evaluate(() => {
      const dict = window.feedComposerFixture.dict;
      const textarea = document.querySelector('textarea');
      const composer = textarea.parentElement.parentElement;
      const rect = composer.getBoundingClientRect();
      const footer = composer.lastElementChild;
      const visible = element => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const controlCenters = [...footer.children].filter(visible).map(element => {
        const box = element.getBoundingClientRect();
        return box.top + box.height / 2;
      });
      const describe = (button, boundary) => {
        const box = button.getBoundingClientRect();
        const shown = visible(button);
        const inset = shown && box.left >= boundary.left && box.right <= boundary.right + 0.5 && box.top >= boundary.top && box.bottom <= boundary.bottom + 0.5;
        const center = shown ? document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) : null;
        return { label: button.getAttribute('aria-label') || button.title || button.textContent, width: box.width, height: box.height,
          left: box.left, top: box.top, right: box.right, bottom: box.bottom, visible: shown,
          inside: Boolean(inset), reachable: shown && (center === button || button.contains(center)) };
      };
      const buttons = [...composer.querySelectorAll('button')].map(button => describe(button, rect));
      const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      const floatingButtons = [...document.querySelectorAll('[data-floating-recorder] button')].map(button => describe(button, viewport));
      const visibleRecorderCounts = Object.fromEntries([dict.recorder.start, dict.recorder.audioOptions].map(label => [label,
        [...document.querySelectorAll('button')].filter(button => (button.getAttribute('aria-label') || button.title || button.textContent) === label && visible(button)).length]));
      return { theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light', textareaFont: getComputedStyle(textarea).fontSize, viewport: { width: innerWidth, height: innerHeight }, composer: { width: rect.width, right: rect.right }, buttons, floatingButtons, visibleRecorderCounts,
        record: dict.recorder.start, recordingOptions: dict.recorder.audioOptions, model: dict.chat.modelLabel,
        send: dict.feedPage.tuningChat.send, stop: dict.feedPage.tuningChat.stop,
        queue: dict.chat.queue.send, overflow: document.documentElement.scrollWidth > innerWidth,
        controlsShareRow: controlCenters.length < 2 || Math.max(...controlCenters) - Math.min(...controlCenters) < 1 };
    });
    const failures = [];
    const recorderLabels = [row.record, row.recordingOptions];
    const desktopFloating = row.viewport.width >= 1024;
    for (const button of row.buttons) {
      const desktopInlineRecorder = desktopFloating && recorderLabels.includes(button.label);
      if (desktopInlineRecorder) {
        if (button.visible) failures.push(`desktop inline recorder must yield to floating host ${button.label}`);
      } else if (!button.visible || !button.inside || !button.reachable) failures.push(`clipped/unreachable ${button.label}`);
    }
    for (const label of recorderLabels) {
      const inline = row.buttons.filter(button => button.label === label);
      const floating = row.floatingButtons.filter(button => button.label === label && button.visible);
      if (inline.length !== 1) failures.push(`missing or duplicate inline recorder ${label}`);
      if (row.visibleRecorderCounts[label] !== 1) failures.push(`expected exactly one visible recorder ${label}`);
      if (!desktopFloating) {
        if (floating.length !== 0) failures.push(`floating recorder must yield to inline below lg ${label}`);
      } else if (floating.length !== 1 || !floating[0].inside || !floating[0].reachable) failures.push(`clipped/unreachable floating recorder ${label}`);
    }
    const primaryLabels = [row.record, row.recordingOptions, row.model, streaming ? row.queue : row.send, ...(streaming ? [row.stop] : [])];
    for (const label of primaryLabels) {
      const action = row.buttons.find(button => button.label === label);
      if (!recorderLabels.includes(label) || !desktopFloating) {
        if (!action || !action.visible) failures.push(`missing primary control ${label}`);
        if (phone && (!action || action.width < 44 || action.height < 44)) failures.push(`touch target ${label}`);
      }
    }
    if (row.overflow) failures.push('document overflow');
    if (phone && parseFloat(row.textareaFont) < 16) failures.push('phone text entry must remain at least 16px');
    if (!phone && !streaming && !row.controlsShareRow) failures.push('idle controls wrapped to a second row');
    results.push({ name, failures, recorderMode: desktopFloating ? 'floating' : 'inline', ...row });
    await page.locator('[data-fixture-rail]').screenshot({ path: join(output, `${name}.png`) });
    if (!phone) await page.screenshot({ path: join(output, `${name}-viewport.png`) });
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/feed-composer-browser.html?image=1`);
    const preview = page.locator('[data-feed-pending-image]').first();
    await page.locator('.ProseMirror p').last().click();
    await preview.locator('img').waitFor();
    const image = await preview.locator('img').evaluate(async element => {
      await element.decode();
      return { src: element.getAttribute('src'), width: element.naturalWidth };
    });
    assert.match(image.src ?? '', /^blob:/, 'Image preview must use the real protected-media object URL');
    assert.ok(image.width > 0, 'Protected fixture image bytes must decode');
    const requests = await page.evaluate(() => window.feedComposerFixture.requests);
    assert.ok(requests.some(request => request.method === 'GET' && /^\/api\/doc-files\/fictional-workspace\/[^/]+$/.test(request.url) && request.cache === 'no-store'), 'Image bytes must use the current workspace authenticated no-store transport');
    const preference = requests.find(request => request.method === 'PATCH' && request.url === '/api/workspaces/fictional-workspace/picker-preferences');
    assert.ok(preference, 'The real workspace provider must announce the synthetic workspace open');
    assert.deepEqual(preference.body, { opened: true }, 'Only the synthetic workspace open preference is written');
    await preview.scrollIntoViewIfNeeded();
    const scroll = page.locator('[data-image-scroll]');
    const before = await scroll.evaluate(el => el.scrollTop);
    await preview.click();
    await page.waitForTimeout(300);
    const dialog = page.getByRole('dialog');
    await page.screenshot({ path: join(output, `image-click-${width}.png`) });
    await dialog.waitFor({ state: 'visible' });
    assert.equal(await scroll.evaluate(el => el.scrollTop), before, 'Opening the image chooser must preserve the draft scroll position');
    const dict = await page.evaluate(() => window.feedComposerFixture.dict);
    await dialog.getByRole('button', { name: dict.feedGeneration.nextImage, exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-feed-image-carousel] img')?.alt === 'Second option');
    await dialog.getByRole('button', { name: dict.feedGeneration.closeDetails, exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await scroll.evaluate(el => el.scrollTop), before, 'Closing the image chooser must preserve the draft scroll position');
    assert.equal(await preview.evaluate(el => el === document.activeElement), true, 'Focus returns to the image preview');
    await preview.focus();
    await preview.press('Enter');
    await dialog.waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await scroll.evaluate(el => el.scrollTop), before, 'Keyboard review preserves scroll');
    assert.equal(await preview.evaluate(el => el === document.activeElement), true, 'Escape returns focus to the preview');
    assert.deepEqual(await page.evaluate(() => window.feedImageFixture.commands), [], 'Reviewing images must not mutate the draft');
    results.push({ name: `image-scroll-${width}`, failures: [] });
  }
  for (const [locale, width] of [['en', 1440], ['en', 390], ['en', 320], ['ja', 390], ['zh', 390], ['zh-cn', 390]]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/feed-composer-browser.html?workflow=1&locale=${locale}`);
    const workflow = page.locator('[data-feed-post-workflow]');
    await workflow.waitFor();
    const dict = await page.evaluate(() => window.feedComposerFixture.dict);
    await page.locator('[data-workflow-scroll]').evaluate(el => { el.scrollTop = 700; });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Workflow must not overflow the phone');
    for (const button of await workflow.getByRole('button').all()) {
      const box = await button.boundingBox();
      assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= 844, 'Workflow action remains visible after scrolling');
      if (width < 768) assert.ok(box.width >= 44 && box.height >= 44, 'Workflow actions have phone touch targets');
    }
    const review = workflow.getByRole('button', { name: dict.feedCollaboration.review, exact: true });
    await review.click();
    const panel = page.locator('[data-feed-editor-panel]');
    await panel.waitFor({ state: 'visible' });
    await page.waitForTimeout(150);
    const box = await panel.boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= 844, 'Review panel fits the viewport');
    await panel.getByRole('button', { name: dict.feedCollaboration.closePanel, exact: true }).click();
    await page.waitForTimeout(150);
    assert.ok(await review.evaluate(el => el === document.activeElement), 'Closing Review restores focus to its visible opener');
    await page.screenshot({ path: join(output, `workflow-${locale}-${width}.png`) });
    for (const [label, stage] of [[dict.feedPage.postEditor.submitForApproval, 'review'], [dict.feedPage.postEditor.approve, 'ready'], [dict.feedPage.postEditor.markPosted, 'posted']]) {
      await workflow.getByRole('button', { name: label, exact: true }).click();
      assert.equal(await workflow.locator('[aria-current="step"]').innerText(), dict.feedPage.posts.status[stage]);
    }
    results.push({ name: `workflow-${locale}-${width}`, failures: [], stages: 4 });
  }
  if (!process.env.FEED_WORKFLOW_ONLY) for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/feed-composer-browser.html?comment=1`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.locator('[contenteditable=true]').waitFor();
    await page.locator('[contenteditable=true] p').nth(12).evaluate(el => el.scrollIntoView({ block: 'center' }));
    await page.locator('[contenteditable=true] p').nth(12).dblclick({ position: { x: 45, y: 10 } });
    const anchorTop = await page.locator('main > header button').evaluate(el => el.getBoundingClientRect().top);
    assert.ok(anchorTop < 0, 'The fixture must reproduce a scrolled-off header opener');
    await page.locator('[data-feed-selection-actions] button').first().click();
    const panel = page.locator('[data-feed-editor-panel]');
    await panel.waitFor({ state: 'visible' });
    await page.waitForTimeout(150);
    const rect = await panel.boundingBox();
    assert.ok(rect && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= 844, 'Comment panel must remain inside the viewport');
    const input = page.getByRole('textbox', { name: 'Discuss this passage' });
    await input.fill('A concrete example would help.');
    await panel.getByRole('button', { name: 'Suggest change', exact: true }).click();
    assert.equal(await panel.locator('textarea').first().inputValue(), 'A concrete example would help.');
    await panel.getByRole('group', { name: 'Comment or suggest', exact: true }).getByRole('button', { name: 'Comment', exact: true }).click();
    assert.equal(await input.inputValue(), 'A concrete example would help.');
    await panel.screenshot({ path: join(output, `comment-${width}.png`) });
    await panel.getByRole('button', { name: 'Send', exact: true }).click();
    const commands = await page.evaluate(() => window.feedCommentFixture.commands);
    assert.equal(commands[0][0].kind, 'comment');
    assert.equal(commands[0][0].text, 'A concrete example would help.');
    results.push({ name: `comment-${width}`, failures: [], width, anchorTop, rect, submitted: true });
  }
  const composerCases = [
    { width: 320, viewportWidth: 1440, height: 844, phone: false },
    { width: 360, viewportWidth: 1440, height: 844, phone: false },
    { width: 390, viewportWidth: 390, height: 844, phone: true },
    { width: 360, viewportWidth: 360, height: 780, phone: true },
    { width: 667, viewportWidth: 667, height: 375, phone: true },
    { width: 320, viewportWidth: 768, height: 1024, phone: false, name: 'tablet-768x1024-rail-320', onlyLocale: 'en' },
    { width: 320, viewportWidth: 1440, height: 900, phone: false, name: 'desktop-1440x900-rail-320', onlyLocale: 'en' },
    { width: 390, viewportWidth: 390, height: 844, phone: true, name: 'phone-390-dark', theme: 'dark' },
    { width: 320, viewportWidth: 1440, height: 900, phone: false, name: 'desktop-1440x900-rail-320-dark', theme: 'dark', onlyLocale: 'en' },
  ];
  if (!process.env.FEED_COMMENT_ONLY && !process.env.FEED_WORKFLOW_ONLY) for (const locale of ['en', 'ja', 'zh', 'zh-cn']) for (const { width, viewportWidth, height, phone, name: caseName, onlyLocale, theme = 'light' } of composerCases) {
    if (onlyLocale && onlyLocale !== locale) continue;
    await page.setViewportSize({ width: viewportWidth, height });
    for (const long of [false, true]) {
      const name = `${locale}-${caseName ?? `${phone ? 'phone' : 'rail'}-${width}`}${long ? '-long' : ''}`;
      await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/feed-composer-browser.html?locale=${locale}&width=${width}${long ? '&long=1' : ''}`);
      await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
      await page.locator('textarea').waitFor();
      const copy = await page.evaluate(() => window.feedComposerFixture.dict.feedPage.tuningChat);
      await page.getByRole('button', { name: await page.evaluate(() => window.feedComposerFixture.dict.recorder.start), exact: true }).waitFor({ state: 'visible' });
      await page.locator('textarea').fill('Improve the fictional opening.');
      await page.locator(`button[title=${JSON.stringify(copy.send)}]`).waitFor({ state: 'visible' });
      await page.waitForFunction(label => !document.querySelector(`button[title="${label}"]`)?.disabled, copy.send);
      await measure(`${name}-idle`, phone, false);
      const picker = page.locator('[data-slot="select-trigger"]');
      assert.equal((await picker.innerText()).trim(), copy.modelStandard, 'Trigger must show the localized short model name');
      if (name === 'en-rail-320') await writeFile(join(output, 'model-accessibility.txt'), await picker.ariaSnapshot());
      await picker.click();
      await page.getByRole('option').nth(2).click();
      assert.equal((await picker.innerText()).trim(), copy.modelMax);
      await picker.click();
      await page.getByRole('option').nth(0).click();
      assert.equal(await page.getByRole('button', { name: copy.research, exact: true }).count(), 0, 'Ordinary Feed requests must not require a manual Research control');
      await page.locator('textarea').press('Enter');
      await page.locator(`button[title=${JSON.stringify(copy.stop)}]`).waitFor();
      const initialRequests = await page.evaluate(() => window.feedComposerFixture.requests.filter(request => request.method === 'POST' && request.url === '/api/chat' && !request.body.inputId));
      assert.equal(initialRequests.length, 1, 'Submitting an ordinary draft must start exactly one turn');
      const initialBody = initialRequests[0].body;
      assert.deepEqual(Object.fromEntries(['message', 'assistantId', 'workspaceId', 'sessionId', 'model'].map(key => [key, initialBody[key]])), {
        message: 'Improve the fictional opening.', assistantId: 'fictional-writer', workspaceId: 'fictional-workspace', sessionId: 'fictional-draft', model: 'standard',
      }, 'Ordinary requests must preserve the task, workspace, session, assistant and selected tier');
      assert.equal(Object.hasOwn(initialBody, 'mode'), false, 'An unseeded Feed request must not pin an explicit research or default mode');
      await page.locator('[data-fixture-rail] .chat-markdown').filter({ hasText: 'Updating the fictional draft.' }).waitFor();
      await page.locator('textarea').fill('Keep the example.');
      await measure(`${name}-streaming`, phone, true);
      const queue = await page.evaluate(() => window.feedComposerFixture.dict.chat.queue.send);
      await page.locator(`button[title=${JSON.stringify(queue)}]`).click();
      await page.waitForFunction(() => window.feedComposerFixture.requests.some(({ body }) => body.message === 'Keep the example.' && body.inputId));
      const queuedRequest = await page.evaluate(() => window.feedComposerFixture.requests.find(request => request.method === 'POST' && request.url === '/api/chat' && request.body.message === 'Keep the example.' && request.body.inputId));
      assert.ok(queuedRequest, 'Queue must post the actual mid-turn input');
      assert.deepEqual(Object.fromEntries(['message', 'assistantId', 'workspaceId', 'sessionId', 'midTurn'].map(key => [key, queuedRequest.body[key]])), {
        message: 'Keep the example.', assistantId: 'fictional-writer', workspaceId: 'fictional-workspace', sessionId: 'fictional-draft', midTurn: true,
      }, 'Queued input must stay with its current task and session');
      assert.equal(Object.hasOwn(queuedRequest.body, 'mode'), false, 'Queued input must not pin an explicit research or default mode');
      await page.locator('[data-fixture-rail]').getByText('Keep the example.', { exact: true }).waitFor();
      const pendingLabel = await page.evaluate(() => window.feedComposerFixture.dict.chat.queue.pending);
      const pendingInput = page.locator('[data-fixture-rail]').getByText(pendingLabel, { exact: true });
      await pendingInput.waitFor();
      await page.locator(`button[title=${JSON.stringify(copy.stop)}]`).waitFor();
      await page.locator(`button[title=${JSON.stringify(copy.stop)}]`).click();
      await page.locator(`button[title=${JSON.stringify(copy.stop)}]`).waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => window.feedComposerFixture.requests.some(({ url }) => url === '/api/chat/stop')), true);
      const stopped = await page.evaluate(() => window.feedComposerFixture.requests.find(request => request.method === 'POST' && request.url === '/api/chat/stop'));
      assert.deepEqual(stopped?.body, { sessionId: 'fictional-draft' }, 'Stop must target the owning session');
      await pendingInput.waitFor({ state: 'hidden' });
    }
  }
  await writeFile(join(output, 'results.json'), JSON.stringify({ errors, results }, null, 2));
  assert.deepEqual(errors, [], 'Unexpected browser errors');
  const failed = results.filter(row => row.failures.length);
  console.log(JSON.stringify({ scenarios: results.length, failures: failed.map(({ name, failures }) => ({ name, failures })), output }, null, 2));
  assert.equal(failed.length, 0, 'Feed composer controls must remain inside their card, reachable and touch-sized');
} finally {
  await browser?.close(); await server.close(); await rm(cache, { recursive: true, force: true });
}
