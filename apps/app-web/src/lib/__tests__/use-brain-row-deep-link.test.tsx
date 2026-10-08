// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBrainRowDeepLink } from '../use-brain-row-deep-link';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), select: vi.fn() }));
vi.mock('../api/brain-inbox', () => ({ fetchBrainRow: mocks.fetch }));
vi.mock('../api/brain', () => ({ projectInboxRowToBrainRow: (row: unknown) => row }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot>;
afterEach(async () => { await act(async () => root.unmount()); vi.clearAllMocks(); });
function Harness({ viewer = 'viewer' }: { viewer?: string }) {
  useBrainRowDeepLink('row=row&kind=deal', { viewerId: viewer, workspaceId: 'workspace', viewpointAssistantId: null }, mocks.select);
  return null;
}
describe('[COMP:app-web/brain-deep-link] authority-scoped navigation', () => {
  it('opens the row after effect replay, ignoring the canceled first response', async () => {
    const resolve: Array<(row: unknown) => void> = [];
    mocks.fetch.mockImplementation(() => new Promise(done => resolve.push(done)));
    root = createRoot(document.createElement('div'));
    await act(async () => root.render(<StrictMode><Harness /></StrictMode>));
    expect(resolve).toHaveLength(2);
    await act(async () => resolve[0]({ id: 'stale', verifiedAt: null }));
    expect(mocks.select).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'stale' }));
    await act(async () => resolve[1]({ id: 'row', verifiedAt: 'verified' }));
    expect(mocks.select).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'row', hasPending: false }));
  });
  it('clears selection and ignores an older viewer response when the new viewer is denied', async () => {
    let finish!: (row: unknown) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise(done => { finish = done; })).mockResolvedValueOnce(null);
    root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Harness />));
    await act(async () => root.render(<Harness viewer="other" />));
    await act(async () => finish({ id: 'private', verifiedAt: null }));
    expect(mocks.select).toHaveBeenLastCalledWith(null);
    expect(mocks.select).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'private' }));
    expect(mocks.fetch).toHaveBeenLastCalledWith('workspace', 'deal', 'row', expect.objectContaining({ viewerId: 'other' }));
  });
});
