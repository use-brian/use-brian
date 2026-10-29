/** Real-browser regression for [COMP:app-web/chat-responsive-controls].
 * Run against the local rig: node scripts/chat-welcome-layout-browser.mjs
 * Requires agent-browser on PATH. Drafts only; never submits a model turn.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function verifyChatWelcomeLayout() {
  const baseUrl = process.env.CHAT_LAYOUT_BASE_URL ?? 'http://localhost:3003';
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(baseUrl).hostname), 'Use a local rig');
  const session = process.env.CHAT_LAYOUT_BROWSER_SESSION ?? 'chat-welcome-layout';
  const output = process.env.CHAT_LAYOUT_OUTPUT ?? '/tmp/chat-welcome-layout';
  mkdirSync(output, { recursive: true });
  function browser(...args) {
    return execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 60_000 });
  }
  function evaluate(source) {
    const response = JSON.parse(execFileSync('agent-browser', ['--session', session, 'eval', '--json', '--stdin'], {
      input: source, encoding: 'utf8', timeout: 30_000,
    }));
    assert.ok(response.success, JSON.stringify(response.error));
    return response.data.result;
  }
  const measure = () => evaluate(`(() => {
    const field = document.querySelector('[data-chat-welcome-composer] textarea');
    const composer = field.closest('[data-brian-chat-composer]');
    const welcome = document.querySelector('[data-chat-welcome-composer]');
    const icon = document.querySelector('[data-chat-welcome-icon]');
    const heading = document.querySelector('[data-chat-greeting] h2');
    const rect = el => { const r = el.getBoundingClientRect(); return { top:r.top, bottom:r.bottom, height:r.height, left:r.left, right:r.right }; };
    return { field:rect(field), composer:rect(composer), welcome:rect(welcome), icon:rect(icon), heading:rect(heading),
      value:field.value, sameInput:window.__welcomeLayoutInput === field, scrollHeight:field.scrollHeight, clientHeight:field.clientHeight,
      viewport:innerHeight, overflow:document.documentElement.scrollWidth > innerWidth,
      iconFilter:getComputedStyle(icon).filter, iconLoaded:icon.complete && icon.naturalWidth > 0,
      decorative:icon.getAttribute('alt') === '' && icon.getAttribute('aria-hidden') === 'true' };
  })()`);

  browser('open', `${baseUrl}/api/auth/dev-login`);
  const location = browser('get', 'url').trim();
  const workspace = new URL(location).pathname.match(/^\/w\/([^/]+)/)?.[1];
  assert.ok(workspace, 'Local dev login must resolve a workspace');
  browser('open', `${baseUrl}/w/${workspace}/chat`);
  // A rig may remember an earlier thread; explicitly start a fresh draft.
  browser('find', 'role', 'button', 'click', '--name', 'New chat', '--exact');
  browser('set', 'viewport', '1440', '1000');
  browser('wait', '[data-chat-welcome-composer] textarea');
  browser('wait', '--fn', 'document.querySelector("[data-chat-welcome-icon]")?.complete');
  evaluate('window.__welcomeLayoutInput = document.querySelector("[data-chat-welcome-composer] textarea"); true');
  const empty = measure();
  assert.equal(evaluate('document.querySelector("[data-chat-work-entry]") !== null'), false, 'Fresh Chat must not render the retired work disclosure');
  assert.ok(empty.welcome.bottom <= empty.viewport && empty.welcome.bottom >= empty.viewport - 80, 'Welcome composer must dock near the bottom');
  assert.ok(empty.icon.bottom < empty.heading.top && empty.heading.bottom < empty.composer.top, 'Brian icon must be above the question and composer');
  assert.ok(empty.iconLoaded && empty.decorative && empty.iconFilter === 'grayscale(1)', 'Use the decorative grey Brian brand icon');
  browser('screenshot', `${output}/desktop.png`);

  const draft = Array.from({ length: 8 }, (_, index) => `Step ${index + 1}: describe a fictional release task.`).join('\n');
  browser('fill', 'textarea', draft);
  const expanded = measure();
  assert.ok(expanded.field.height > empty.field.height + 100, 'Multiline prompt must grow the field');
  assert.ok(expanded.composer.top < empty.composer.top, 'Composer must grow upward');
  assert.ok(Math.abs(expanded.composer.bottom - empty.composer.bottom) <= 2, 'Composer bottom must remain anchored');
  browser('fill', 'textarea', Array.from({ length: 60 }, () => 'A long draft line.').join('\n'));
  const capped = measure();
  assert.ok(capped.field.height <= 241 && capped.scrollHeight > capped.clientHeight, 'Long prompts must scroll within the height cap');
  assert.ok(capped.composer.bottom < capped.viewport, 'Toolbar must remain on screen');
  browser('fill', 'textarea', draft);
  browser('screenshot', `${output}/desktop-draft.png`);

  browser('set', 'viewport', '390', '844');
  const phone = measure();
  assert.ok(phone.sameInput && phone.value === draft, 'Resize must preserve the input and its draft');
  assert.ok(!phone.overflow && phone.composer.bottom <= phone.viewport, 'Phone composer must fit the viewport');
  assert.ok(phone.welcome.bottom >= phone.viewport - 40, 'Phone composer must remain at the bottom');
  browser('screenshot', `${output}/phone-draft.png`);
  // The installed native driver treats an empty fill argument as omitted.
  browser('fill', 'textarea', 'x');
  browser('press', 'Backspace');
  const cleared = measure();
  assert.ok(cleared.sameInput && cleared.field.height < phone.field.height, 'Clearing must shrink the same field');
  browser('screenshot', `${output}/phone.png`);
  browser('set', 'viewport', '844', '390');
  assert.ok(evaluate('getComputedStyle(document.querySelector("[data-chat-greeting]")).display === "none"'), 'Short windows must prioritize the composer');
  assert.ok(measure().composer.bottom <= 390, 'Landscape composer must remain reachable');
  browser('set', 'viewport', '1440', '1000');
  assert.ok(Math.abs(measure().field.height - empty.field.height) <= 2, 'Empty prompt must return to its original height');
  console.log(JSON.stringify({ desktop:empty.field.height, expanded:expanded.field.height, capped:capped.field.height, phone:phone.field.height, cleared:cleared.field.height, output }));
  browser('close');

}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyChatWelcomeLayout();
}
