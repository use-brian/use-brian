import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import assert from 'node:assert/strict';

// Execute the hosts' actual deferred fallback bodies without mounting their
// unrelated editor/recorder dependencies. A drain is destructive, so testing
// just the eventual send guard would miss lost inputs on session switches.
for (const [host, selected, epoch] of [
  ['chrome/floating-chat', 'sessionIdRef', 'threadEpochRef'],
  ['feed/tuning-chat-panel', 'selectedSessionIdRef', 'epochRef'],
]) {
  const source = readFileSync(new URL(`../../${host}.tsx`, import.meta.url), 'utf8');
  const start = source.indexOf('  const flushQueuedInputs = useCallback(');
  const block = source.slice(start, source.indexOf('  }, [midTurn]);', start));
  const body = block.slice(block.indexOf('=> {') + 4);
  function setup() {
    const selection = { current: 'a' };
    const generation = { current: 0 };
    const calls = [];
    let timer;
    const flush = new Function('owningSessionId', selected, epoch, 'midTurn', 'sendMessageRef', 'joinQueuedInputs', 'setTimeout', 'appliedInputIdsRef', body);
    flush('a', selection, generation, {
      drain: (sid) => { calls.push(['drain', sid]); return [{ text: 'follow-up' }]; },
    }, { current: (text) => calls.push(['send', text]) }, (items) => items.map(x => x.text).join('\n\n'), (fn) => { timer = fn; }, { current: new Set() });
    return { selection, generation, calls, run: () => timer() };
  }
  test(`[COMP:app-web/mid-turn-queue] ${host}: switch before timer blocks stale fallback`, () => {
    const state = setup();
    state.selection.current = 'b';
    state.run();
    assert.deepEqual(state.calls, []);
  });
  test(`[COMP:app-web/mid-turn-queue] ${host}: same owner drains then sends`, () => {
    const state = setup();
    assert.deepEqual(state.calls, []);
    state.run();
    assert.deepEqual(state.calls, [['drain', 'a'], ['send', 'follow-up']]);
  });
  test(`[COMP:app-web/mid-turn-queue] ${host}: reset invalidates pending fallback`, () => {
    const state = setup();
    state.generation.current++;
    state.run();
    assert.deepEqual(state.calls, []);
  });
}

const entrySource = readFileSync(new URL('../../brain/entry-thread.tsx', import.meta.url), 'utf8');
const entryTimer = entrySource.match(/setTimeout\(\(\) => \{\n        if \(!owningSessionId[\s\S]*?\n      \}, 0\);/)[0];
for (const selected of ['a', 'b']) {
  test(`[COMP:app-web/mid-turn-queue] entry-thread: deferred fallback with selected ${selected}`, () => {
    const calls = [];
    new Function('owningSessionId', 'sessionRef', 'midTurn', 'sendRef', 'joinQueuedInputs', 'setTimeout', entryTimer)(
      'a', { current: { sessionId: selected } },
      { drain: sid => { calls.push(['drain', sid]); return [{ text: 'follow-up' }]; } },
      { current: text => calls.push(['send', text]) }, items => items[0].text, fn => fn(),
    );
    assert.deepEqual(calls, selected === 'a' ? [['drain', 'a'], ['send', 'follow-up']] : []);
  });
}
