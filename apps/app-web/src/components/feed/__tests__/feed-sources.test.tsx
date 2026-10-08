// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '@/lib/i18n/dictionaries/en';
const state = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock('@/lib/i18n/client', () => ({ useT: () => en }));
vi.mock('@/lib/surface-cache', () => ({ useCachedResource: () => ({ data: { sources: [{ id: 'source-a', name: 'Selected research', sensitivity: 'internal', departmentNames: ['Research'], departmentCount: 1 }] }, loading: false, error: state.error }) }));
vi.mock('@/lib/surface-prefetch', () => ({ feedSourcesCacheKey: () => 'source-cache' }));
vi.mock('@/lib/feed-collaboration', () => ({ feedCollaborationPath: () => '/draft' }));
vi.mock('@/components/ui/searchable-select', () => ({ SearchableSelect: ({ items, onValueChange, disabled }: { items: { value: string; label: string }[]; onValueChange: (id: string) => void; disabled: boolean }) => <>{items.map(item => <button key={item.value} disabled={disabled} onClick={() => onValueChange(item.value)}>{item.label}</button>)}</> }));
import { FeedSources } from '../feed-sources';
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); state.error = null; host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function click(label: string) { const button = [...host.querySelectorAll('button')].find(item => item.textContent === label); expect(button).toBeTruthy(); await act(async () => button!.click()); }
describe('[COMP:app-web/feed-sources] explicit selected memory commands', () => {
  it('adds and removes exact source ids through the same revisioned command callback', async () => {
    const onCommand = vi.fn().mockResolvedValue(true);
    const props = { workspaceId: 'workspace', assistantId: 'assistant', sessionId: 'draft', disabled: false, onCommand };
    await act(async () => root.render(<FeedSources {...props} selected={[]} />));
    await click(en.feedPage.postEditor.selectedSources);
    expect(host.textContent).toContain('Selected research · internal · Research');
    await click('Selected research · internal · Research');
    expect(onCommand).toHaveBeenCalledWith([{ kind: 'context', selectedMemoryIds: ['source-a'] }]);
    await act(async () => root.render(<FeedSources {...props} selected={['source-a']} />));
    await click(en.feedPage.postEditor.removeSource);
    expect(onCommand).toHaveBeenLastCalledWith([{ kind: 'context', selectedMemoryIds: [] }]);
  });
  it('hides cached private source names after an authoritative access failure', async () => {
    state.error = new Error('source_access_required');
    await act(async () => root.render(<FeedSources workspaceId="workspace" assistantId="assistant" sessionId="draft" selected={['source-a']} disabled={false} onCommand={vi.fn()} />));
    await click(en.feedPage.postEditor.selectedSources);
    expect(host.textContent).not.toContain('Selected research');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(en.feedPage.postEditor.sourceAccessBlocked);
  });
});
