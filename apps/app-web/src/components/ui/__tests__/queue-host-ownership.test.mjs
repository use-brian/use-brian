import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import assert from 'node:assert/strict';

// The deferred fallback that turns queued mid-turn text into an ordinary turn
// at the end of a turn belongs to the conversation controller (its drain is
// tested in lib/chat/__tests__/conversation-controller.test.ts, "queue drain
// ownership"). chrome/floating-chat (WP-C), brain/entry-thread (WP-E batch 2)
// and feed/tuning-chat-panel (WP-E batch 1) gave up their own copies; a host
// that grows a private fallback again would race the controller's drain and
// could send the same text twice.
for (const host of ['feed/tuning-chat-panel', 'chrome/floating-chat', 'brain/entry-thread']) {
  test(`[COMP:app-web/mid-turn-queue] ${host}: no private queue fallback`, () => {
    const source = readFileSync(new URL(`../../${host}.tsx`, import.meta.url), 'utf8');
    assert.equal(source.includes('flushQueuedInputs'), false);
    assert.equal(source.includes('useMidTurnQueue('), false);
  });
}
