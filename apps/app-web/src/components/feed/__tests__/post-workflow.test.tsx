// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '@/lib/i18n/dictionaries/en';
import { FeedPostWorkflow } from '../post-workflow';

vi.mock('@/lib/i18n/client', () => ({ useT: () => en }));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const te = en.feedPage.postEditor;
const button = (label: string) => [...host.querySelectorAll('button')].find(node => node.textContent === label)!;

describe('[COMP:app-web/feed-post-workflow] visible editorial workflow', () => {
  const cases = [
    { status: 'drafting', hasEdits: false, label: te.submitForApproval, action: 'onCommit' },
    { status: 'review', hasEdits: true, label: te.saveChanges, action: 'onCommit' },
    { status: 'review', hasEdits: false, label: te.approve, action: 'onApprove' },
    { status: 'ready', hasEdits: false, label: te.markPosted, action: 'onPosted' },
  ] as const;
  it.each(cases)('exposes the next action for $status (edited: $hasEdits)', async ({ status, hasEdits, label, action }) => {
    const handlers = { onCommit: vi.fn(), onApprove: vi.fn(), onPosted: vi.fn(), onReview: vi.fn() };
    await act(async () => root.render(<FeedPostWorkflow {...handlers} status={status} hasEdits={hasEdits} actionDisabled={false} reviewOpen={false} />));
    expect(host.querySelector('[aria-current="step"]')?.textContent).toBe(en.feedPage.posts.status[status]);
    expect(host.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    expect(host.textContent).not.toContain(en.feedPage.posts.status.posted);
    if (hasEdits) expect(button(te.approve)).toBeUndefined();
    await act(async () => button(label).click());
    for (const name of ['onCommit', 'onApprove', 'onPosted', 'onReview'] as const) {
      expect(handlers[name]).toHaveBeenCalledTimes(name === action ? 1 : 0);
    }
  });
  it('keeps Review inspectable while the next action is blocked and returns its own anchor', async () => {
    const handlers = { onCommit: vi.fn(), onApprove: vi.fn(), onPosted: vi.fn(), onReview: vi.fn() };
    await act(async () => root.render(<FeedPostWorkflow {...handlers} status="review" hasEdits={false} actionDisabled reviewOpen />));
    expect(button(te.approve).disabled).toBe(true);
    const review = button(en.feedCollaboration.review);
    expect(review.disabled).toBe(false);
    expect(review.getAttribute('aria-expanded')).toBe('true');
    await act(async () => { button(te.approve).click(); review.click(); });
    expect(handlers.onReview).toHaveBeenCalledWith(review);
    expect(handlers.onApprove).not.toHaveBeenCalled();
  });
  it('shows the final stage without another publication action', async () => {
    await act(async () => root.render(<FeedPostWorkflow status="posted" hasEdits={false} actionDisabled={false} reviewOpen={false} onCommit={vi.fn()} onApprove={vi.fn()} onPosted={vi.fn()} />));
    expect(host.querySelector('[aria-current="step"]')?.textContent).toBe(en.feedPage.posts.status.posted);
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });
});
