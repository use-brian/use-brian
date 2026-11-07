// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublishedTemplateViewer } from '../published-template-viewer';
import { OfficeTemplateLibrary } from '../template-library';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
import { documentFixture, uid } from './editor-fixtures';
import { resetSurfaceCache } from '@/lib/surface-cache';
const state = vi.hoisted(() => ({ fetch: vi.fn(), push: vi.fn(), params: '', viewer: 'viewer' }));
vi.mock('@/lib/user', () => ({ getUserInfo: () => ({ id: state.viewer }) }));
vi.mock('@/lib/auth-fetch', () => ({ authFetch: (...args: unknown[]) => state.fetch(...args) }));
vi.mock('@/lib/workspace-context', () => ({ useOptionalWorkspaceContext: () => ({ workspaceId: 'workspace', me: { id: state.viewer } }) }));
vi.mock('@/lib/use-doc-media', () => ({ useOfficeResourceUrls: () => ({ urls: {} }) }));
vi.mock('../office-topbar', () => ({ OfficeTopbar: () => null }));
vi.mock('../office-card-preview', () => ({ OfficeCardPreview: () => null }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: state.push, replace: vi.fn() }), useSearchParams: () => new URLSearchParams(state.params), usePathname: () => '/w/workspace/office/templates/template' }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const response = (body: unknown, ttl = '6000') => new Response(JSON.stringify(body), { headers: { 'Cache-Control': 'private, no-store', 'X-Brian-Projection-Valid-For-Ms': ttl } });
let host: HTMLDivElement, root: Root;
function button(text: string) { return [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!; }
async function render(node: React.ReactNode) { await act(async () => root.render(<I18nProvider locale="en" dict={en}>{node}</I18nProvider>)); }
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); resetSurfaceCache(); state.params = ''; state.viewer = 'viewer'; host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); resetSurfaceCache(); vi.useRealTimers(); });
describe('[COMP:app-web/office-published-template] Published template UI', () => {
  it('renders every published page and removes protected content when the read expires', async () => {
    const snapshot = documentFixture(); snapshot.title = 'Published source'; snapshot.resources = [];
    snapshot.sections.push({ ...structuredClone(snapshot.sections[0]), id: uid(888) });
    state.fetch.mockResolvedValue(response({ snapshot }, '800'));
    await render(<PublishedTemplateViewer workspaceId="workspace" viewerId="viewer" templateId="template" versionId="version" />);
    expect(state.fetch.mock.calls[0][0]).toContain('/templates/template/versions/version');
    expect(host.querySelectorAll('[id^="published-template-page-"]').length).toBeGreaterThanOrEqual(2);
    const scroll = vi.fn(); host.querySelectorAll<HTMLElement>('[id^="published-template-page-"]')[1].scrollIntoView = scroll;
    act(() => host.querySelectorAll<HTMLButtonElement>('nav button')[1].click()); expect(scroll).toHaveBeenCalled();
    state.fetch.mockImplementation(() => new Promise(() => {}));
    await act(async () => vi.advanceTimersByTime(801)); expect(host.querySelector('[data-office-published-template]')).toBeNull();
  });
  it('exposes viewing and creates a named draft from the selected published version', async () => {
    state.params = 'selected=1';
    const template = { id: 'template', name: 'Published template', description: 'Guidance', family: 'document', lifecycleState: 'admitted', currentVersionId: 'published-version', draftArtifactId: 'mutable-draft', sensitivity: 'internal' };
    state.fetch.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? response({ id: 'new-template', draftArtifactId: 'new-draft' }) : response({ templates: [template] }));
    await render(<OfficeTemplateLibrary workspaceId="workspace" templateId="template" />);
    expect(button(en.office.viewPublishedTemplate)).toBeDefined();
    await act(async () => button(en.office.createFromPublishedTemplate).click());
    const form = document.querySelector('form')!;
    await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    const post = state.fetch.mock.calls.find(call => call[1]?.method === 'POST')!;
    expect(post[0]).toContain('/templates/template/versions/published-version/copy');
    expect(JSON.parse(post[1].body)).toEqual({ name: 'Published template (copy)' });
    expect(state.push).toHaveBeenCalledWith('/w/workspace/office/new-draft?templateId=new-template');
  });
});
