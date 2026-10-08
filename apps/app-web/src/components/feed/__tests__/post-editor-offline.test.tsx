// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "@/lib/i18n/dictionaries/en";

const state = vi.hoisted(() => ({ data: new Map<string, unknown>(), push: vi.fn(), canDraft: true, offline: true, chatProps: null as Record<string, unknown> | null }));
vi.mock("@/lib/user", () => ({ getUserInfo: () => ({ id: "viewer-a" }) }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn(async () => { throw new Error("offline"); }) }));
vi.mock("@/lib/i18n/client", async () => { const { en } = await import("@/lib/i18n/dictionaries/en"); return { useT: () => en, useLocale: () => "en" }; });
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("@/lib/offline/use-offline-sync", () => ({ useIsOffline: () => state.offline }));
vi.mock("@/lib/recorder/dock-recorder-bridge", () => ({ useGlobalDockRecorder: () => null }));
vi.mock("@/components/feed/tuning-chat-panel", () => ({ TuningChatPanel: (props: Record<string, unknown>) => { state.chatProps = props; return null; } }));
vi.mock("@/components/feed/post-media-tray", () => ({ PostMediaTray: () => null }));
vi.mock("@/contexts/feed-profiles-context", () => ({ useFeedWorkspace: () => ({
  workspaceId: "workspace-1", name: "Demo", profiles: [], assistants: [{ id: "assistant-1", name: "Writer" }],
  canDraft: state.canDraft, me: { id: "viewer-a" }, role: "owner", brand: null,
}) }));
vi.mock("@/lib/offline/idb", () => ({
  idbGet: async (key: string) => structuredClone(state.data.get(key) ?? null),
  idbSet: async (key: string, value: unknown) => { state.data.set(key, structuredClone(value)); },
  idbDelete: async (key: string) => { state.data.delete(key); },
  idbUpdate: async (key: string, update: (v: unknown) => unknown) => {
    const next = update(structuredClone(state.data.get(key) ?? null));
    state.data.set(key, structuredClone(next)); return next;
  },
}));
import { EditorView } from '@tiptap/pm/view';
import { TextSelection } from '@tiptap/pm/state';
import { feedCollaborationCacheKey } from '@/lib/surface-prefetch';
import { PostEditor } from "../post-editor";
import { blankFeedContent, createLocalFeedPost, readLocalFeedPost, readFeedNewPostForm } from "@/lib/offline/feed-offline";
import { authFetch } from "@/lib/auth-fetch";
import { resetSurfaceCache, markSurfaceCacheStale } from '@/lib/surface-cache';

let root: Root;
let container: HTMLDivElement;
async function render(sessionId: string | null, platform: "threads" | "twitter" | "linkedin" = "threads") {
  await act(async () => { root.render(<PostEditor platform={platform} sessionId={sessionId} />); });
}
async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function openDetails() {
  await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="${en.feedCollaboration.postActions}"]`)!.click());
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === en.feedCollaboration.details)!;
  await act(async () => item.click());
}
async function remount() {
  await act(async () => root.unmount());
  root = createRoot(container);
}
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.data.clear(); state.push.mockReset(); state.canDraft = true; state.offline = true;
  resetSurfaceCache();
  vi.mocked(authFetch).mockReset().mockRejectedValue(new Error('offline'));
  Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});

describe('[COMP:app-web/feed-post-editor] unavailable history', () => {
  it('withholds the editor and chat and offers a read-only retry and posts route', async () => {
    state.offline=false; state.chatProps=null;
    Object.defineProperty(navigator,'onLine',{value:true,configurable:true});
    vi.mocked(authFetch).mockImplementation(async url => new Response(JSON.stringify(String(url).includes('draft-sessions?') ? {sessions:[]} : [])));
    await render('unavailable-post');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(en.feedPage.postEditor.loadFailed);
    expect(container.querySelector('textarea,[contenteditable]')).toBeNull();
    expect(container.textContent).not.toContain(en.feedPage.postEditor.synced);
    expect(state.chatProps).toBeNull();
    const retry=[...container.querySelectorAll('button')].find(b=>b.textContent===en.feedPage.postEditor.retryLoad)!;
    expect(retry).toBeTruthy();
    vi.mocked(authFetch).mockClear();
    await act(async()=>retry.click());
    expect(vi.mocked(authFetch).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(authFetch).mock.calls.every(([,init])=>!init?.method||init.method==='GET')).toBe(true);
    const back=[...container.querySelectorAll('button')].find(b=>b.textContent===en.feedPage.postEditor.backToPosts)!;
    await act(async()=>back.click());
    expect(state.push).toHaveBeenCalledWith('/w/workspace-1/feed/threads/posts');
  });
});

describe('[COMP:app-web/feed-post-editor] automatic legacy upgrade', () => {
  async function legacyPost() {
    const post = await createLocalFeedPost('assistant-1', 'threads', { ...blankFeedContent(), text: 'Keep the existing copy.' });
    const records = state.data.get('feed:working:viewer-a') as Record<string, typeof post>;
    const stored = records[`assistant-1:${post.session.id}`]!;
    Object.assign(stored, { dirty: false, newSession: false, revision: 3 });
    return stored;
  }
  function goOnline(post: Awaited<ReturnType<typeof legacyPost>>, denied = false) {
    state.offline = false;
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    vi.mocked(authFetch).mockImplementation(async (url, init) => {
      const path = String(url); let body: unknown = {};
      if (path.includes('/commands')) {
        if (denied) return new Response('{}', { status: 403 });
        const request = JSON.parse(init!.body as string);
        body = { receipt: { mutationId: request.mutationId, revision: request.expectedRevision + 1, sequence: 0, threadIds: [], suggestionIds: [] } };
      } else if (init?.method === 'PUT') {
        const request = JSON.parse(init.body as string);
        body = { copy: { ...request, revision: request.revision + 1 } };
      } else if (path.includes('/post-working-copies/')) body = { copy: structuredClone(post) };
      else if (path.endsWith('/messages')) body = [];
      else if (path.endsWith('/saved-drafts')) body = { drafts: [] };
      else if (path.endsWith('/collaboration')) body = { copy: null, threads: [], suggestions: [] };
      else if (path.endsWith('/learning')) body = { confirmations: [], summaries: [], lessons: [] };
      else if (path.includes('/draft-sessions?')) body = { sessions: [post.session] };
      return new Response(JSON.stringify(body), { status: 200 });
    });
  }
  const commands = () => vi.mocked(authFetch).mock.calls.filter(([url, init]) => String(url).endsWith('/commands') && init?.method === 'POST');
  it('withholds an open editor after a collaboration read denies access', async () => {
    const post=await legacyPost();goOnline(post);await render(post.session.id);
    expect(container.querySelector('[data-feed-composition]')).toBeTruthy();
    const previous=vi.mocked(authFetch).getMockImplementation()!;
    vi.mocked(authFetch).mockImplementation((url,init)=>String(url).endsWith('/collaboration')?Promise.resolve(new Response('{}',{status:403})):previous(url,init));
    await act(async()=>{markSurfaceCacheStale(feedCollaborationCacheKey('workspace-1','assistant-1',post.session.id));});
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(en.feedPage.postEditor.loadFailed);
    expect(container.querySelector('[data-feed-composition],textarea,[contenteditable]')).toBeNull();
    expect(container.textContent).not.toContain('Keep the existing copy.');
  });
  it('opens Review directly from the workflow without starting a model request or submitting the draft', async () => {
    const post = await legacyPost(); goOnline(post); await render(post.session.id);
    const workflow = container.querySelector('[data-feed-post-workflow]')!;
    const review = [...workflow.querySelectorAll('button')].find(node => node.textContent === en.feedCollaboration.review)!;
    expect(review).toBeTruthy();
    expect(workflow.textContent).toContain(en.feedPage.postEditor.submitForApproval);
    vi.mocked(authFetch).mockClear();
    await act(async () => review.click());
    expect(review.getAttribute('aria-expanded')).toBe('true');
    const panel = document.querySelector('[data-feed-editor-panel]')!;
    expect(panel.hasAttribute('hidden')).toBe(false);
    expect(panel.textContent).toContain(en.feedReview.checks);
    expect(vi.mocked(authFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    await act(async () => panel.querySelector<HTMLButtonElement>(`[aria-label="${en.feedCollaboration.closePanel}"]`)!.click());
    expect(review.getAttribute('aria-expanded')).toBe('false');
  });
  it('keeps passive editor selection out of chat and pins only Ask Brian context', async () => {
    const viewProps = vi.spyOn(EditorView.prototype, 'setProps');
    try {
      const post = await legacyPost(); goOnline(post); await render(post.session.id);
      const view = (viewProps.mock.contexts as EditorView[]).find(item => item.dom === container.querySelector('[contenteditable]'))!;
      expect(view).toBeTruthy();
      await act(async () => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 5))));
      expect(state.chatProps?.feedTarget).not.toHaveProperty('target');
      expect(state.chatProps?.feedSelection).toBeUndefined();
      await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="${en.feedCollaboration.documentActions}"]`)!.click());
      const ask = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === en.feedCollaboration.askBrian)!;
      await act(async () => ask.click());
      expect(state.chatProps?.feedSelection).toMatchObject({ quote: 'Keep', target: { kind: 'range' } });
      await act(async () => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6, 9))));
      expect(state.chatProps?.feedSelection).toMatchObject({ quote: 'Keep' });
      await act(async () => (state.chatProps?.onClearFeedSelection as () => void)());
      expect(state.chatProps?.feedSelection).toBeUndefined();
      expect(state.chatProps?.feedTarget).not.toHaveProperty('target');
    } finally { viewProps.mockRestore(); }
  });
  it('opens an existing writable post in the composition editor without an enable action', async () => {
    const post = await legacyPost(); goOnline(post);
    await render(post.session.id);
    expect(commands()).toHaveLength(1);
    expect(container.querySelector('[data-feed-composition]')?.textContent).toContain('Keep the existing copy.');
    expect(container.textContent).not.toContain('Enable draft collaboration');
    expect(await readLocalFeedPost('assistant-1', post.session.id)).toMatchObject({ dirty: false, revision: 4, content: { schemaVersion: 2 } });
    await render(post.session.id);
    expect(commands()).toHaveLength(1);
  });
  it('syncs a new post and upgrades automatically, with no extra action after creation', async () => {
    const post = await createLocalFeedPost('assistant-1', 'threads', blankFeedContent());
    goOnline(post); await render(post.session.id);
    expect(container.querySelector('[data-feed-composition]')).not.toBeNull();
    expect(commands()).toHaveLength(1);
    expect(await readLocalFeedPost('assistant-1', post.session.id)).toMatchObject({ newSession: false, dirty: false, content: { schemaVersion: 2 } });
  });
  it('retains offline typing and enters the new editor on reconnect', async () => {
    const post = await createLocalFeedPost('assistant-1', 'threads', blankFeedContent());
    await render(post.session.id);
    await type(container.querySelector('textarea')!, 'Written offline');
    expect(authFetch).not.toHaveBeenCalled();
    goOnline(post); await render(post.session.id);
    expect(container.querySelector('[data-feed-composition]')?.textContent).toContain('Written offline');
    expect(commands()).toHaveLength(1);
  });
  it.each(['ready', 'posted', 'viewer'] as const)('does not mutate %s content when the editor opens', async status => {
    const post = await legacyPost();
    if (status === 'viewer') state.canDraft = false;
    else post.session.selectedDraft = { text: post.content.text, status };
    goOnline(post); await render(post.session.id);
    expect(commands()).toHaveLength(0);
    expect(vi.mocked(authFetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
    expect((await readLocalFeedPost('assistant-1', post.session.id))?.content.schemaVersion).toBeUndefined();
  });
  it('retries a paused save through the editor and removes the recovery controls after success', async () => {
    const post = await legacyPost(); goOnline(post, true); await render(post.session.id);
    const rejected = commands()[0][1]!.body;
    const retry = [...container.querySelectorAll('button')].find(button => button.textContent === en.feedPage.postEditor.retrySync)!;
    expect(retry.disabled).toBe(false);
    goOnline(post);
    await act(async () => retry.click());
    expect(commands()).toHaveLength(2);
    expect(commands()[1][1]!.body).toBe(rejected);
    expect(await readLocalFeedPost('assistant-1', post.session.id)).toMatchObject({ dirty: false, revision: 4 });
    expect(container.textContent).not.toContain(en.feedPage.postEditor.retrySync);
    expect(container.textContent).not.toContain(en.feedPage.postEditor.saveAsNewPost);
  });
  it('keeps recovery visible and disables both actions until a delayed retry succeeds', async () => {
    const post = await legacyPost(); goOnline(post, true); await render(post.session.id);
    const notice = container.querySelector('[data-feed-sync-recovery]')!;
    expect(notice.getAttribute('aria-label')).toBe(en.feedPage.postEditor.syncPaused);
    expect(notice.textContent).toContain(en.feedPage.postEditor.syncBlocked);
    const header = container.querySelector('[data-feed-document-header]')!;
    expect(header.textContent).toContain(en.feedPage.postEditor.syncPaused);
    expect(header.textContent).not.toContain(en.feedPage.postEditor.syncBlocked);
    goOnline(post);
    const respond = vi.mocked(authFetch).getMockImplementation()!;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(authFetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/commands')) await pending;
      return respond(url, init);
    });
    await act(async () => notice.querySelector<HTMLButtonElement>('button')!.click());
    const retrying = container.querySelector('[data-feed-sync-recovery]')!;
    expect(retrying.textContent).toContain(en.feedPage.postEditor.retryingSync);
    expect([...retrying.querySelectorAll('button')].every(button => button.disabled)).toBe(true);
    await act(async () => release());
    expect(container.querySelector('[data-feed-sync-recovery]')).toBeNull();
    expect(await readLocalFeedPost('assistant-1', post.session.id)).toMatchObject({ dirty: false });
  });
  it('keeps the copy action available offline and carries the preserved text into a new post', async () => {
    const post = await legacyPost(); goOnline(post, true); await render(post.session.id);
    state.offline = true;
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    await render(post.session.id);
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('[data-feed-sync-recovery] button')];
    expect(buttons[0].disabled).toBe(true);
    expect(buttons[1].disabled).toBe(false);
    await act(async () => buttons[1].click());
    const destination = state.push.mock.calls[0][0] as string;
    const copy = await readLocalFeedPost('assistant-1', destination.split('/').at(-1)!);
    expect(copy?.content.text).toBe(post.content.text);
    expect(copy?.session.id).not.toBe(post.session.id);
  });
  it('offers only a new copy for unsynced edits on a read-only post', async () => {
    const post = await legacyPost();
    post.dirty = true;
    post.session.selectedDraft = { text: post.content.text, status: 'ready' };
    await render(post.session.id);
    const notice = container.querySelector('[data-feed-sync-recovery]')!;
    expect(notice.textContent).toContain(en.feedPage.postEditor.syncReadOnly);
    expect(notice.querySelectorAll('button')).toHaveLength(1);
    expect(notice.querySelector('button')!.textContent).toBe(en.feedPage.postEditor.saveAsNewPost);
  });
  it('retains denied work and exposes recovery without repeatedly retrying the upgrade', async () => {
    const post = await legacyPost(); goOnline(post, true); await render(post.session.id);
    expect(commands()).toHaveLength(1);
    expect(await readLocalFeedPost('assistant-1', post.session.id)).toMatchObject({ dirty: true, error: 'blocked', content: { text: 'Keep the existing copy.' } });
    expect(container.textContent).toContain(en.feedPage.postEditor.syncBlocked);
    expect(container.textContent).toContain(en.feedPage.postEditor.saveAsNewPost);
    await render(post.session.id); expect(commands()).toHaveLength(1);
  });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe("[COMP:app-web/feed-offline] offline editor lifecycle", () => {
  it("saves caption keystrokes immediately and restores after closing the editor", async () => {
    const post = await createLocalFeedPost("assistant-1", "threads", blankFeedContent());
    await render(post.session.id);
    await type(container.querySelector("textarea")!, "Written during a flight");
    expect((await readLocalFeedPost("assistant-1", post.session.id))?.content.text).toBe("Written during a flight");
    // No debounce/timer needs to fire before the user navigates away.
    await remount(); await render(post.session.id);
    expect(container.querySelector("textarea")?.value).toBe("Written during a flight");
    expect(container.textContent).toContain(en.feedPage.postEditor.savedLocally);
    const commit = [...container.querySelectorAll("button")].find(b => b.textContent === en.feedPage.postEditor.submitForApproval)!;
    expect(commit.disabled).toBe(true);
    expect(authFetch).not.toHaveBeenCalled();
  });
  it("shows a cached AI proposal when a new post has never been typed into", async () => {
    const post = await createLocalFeedPost("assistant-1", "threads", blankFeedContent());
    const records = state.data.get("feed:working:viewer-a") as Record<string, typeof post>;
    records[`assistant-1:${post.session.id}`].newSession = false;
    state.data.set(`feed:cache:viewer-a:/api/sessions/${post.session.id}/messages`, { feedAuthority: 1, confirmedAt: Date.now(), value: [{
      role: "assistant", content: [{ type: "tool_use", name: "proposeDrafts", input: { drafts: [{ index: 1, text: "An AI suggestion" }] } }],
    }] });
    await render(post.session.id);
    expect(container.querySelector("textarea")?.value).toBe("An AI suggestion");
  });
  it("keeps an intentionally empty caption even when cached AI proposals exist", async () => {
    const post = await createLocalFeedPost("assistant-1", "threads", { ...blankFeedContent(), text: "My original caption" });
    const records = state.data.get("feed:working:viewer-a") as Record<string, typeof post>;
    records[`assistant-1:${post.session.id}`].newSession = false;
    state.data.set(`feed:cache:viewer-a:/api/sessions/${post.session.id}/messages`, { feedAuthority: 1, confirmedAt: Date.now(), value: [{
      role: "assistant", content: [{ type: "tool_use", name: "proposeDrafts", input: { drafts: [{ index: 1, text: "An AI suggestion" }] } }],
    }] });
    await render(post.session.id);
    await type(container.querySelector("textarea")!, "");
    expect(container.querySelector("textarea")?.value).toBe("");
    await remount(); await render(post.session.id);
    expect(container.querySelector("textarea")?.value).toBe("");
  });
  it("retains the new-post title and private brief before Create is pressed", async () => {
    await render(null);
    await type(container.querySelector('input[type="text"]')!, "New idea");
    await type(container.querySelector("textarea")!, "Private context, half finished");
    expect((await readFeedNewPostForm("assistant-1", "threads"))?.privateBrief).toBe("Private context, half finished");
    await remount(); await render(null);
    expect(container.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe("New idea");
    expect(container.querySelector("textarea")?.value).toBe("Private context, half finished");
  });
  it("restores unfinished article fields without requiring a valid URL", async () => {
    const post = await createLocalFeedPost("assistant-1", "linkedin", { ...blankFeedContent(), postFormat: "article" });
    await render(post.session.id, "linkedin");
    expect(container.querySelector('input[type="url"]')).toBeNull();
    await openDetails();
    await type(document.querySelector<HTMLInputElement>('input[type="url"]')!, "https://exam");
    await type(document.querySelector<HTMLInputElement>(`input[placeholder="${en.feedPage.postEditor.articleTitlePlaceholder}"]`)!, "An unfinished headline");
    await remount(); await render(post.session.id, "linkedin"); await openDetails();
    expect(document.querySelector<HTMLInputElement>('input[type="url"]')?.value).toBe("https://exam");
    expect((await readLocalFeedPost("assistant-1", post.session.id))?.content.article.title).toBe("An unfinished headline");
  });
  it("restores incomplete threads and title edits after navigation", async () => {
    const post = await createLocalFeedPost("assistant-1", "twitter", { ...blankFeedContent(), postFormat: "thread" });
    await render(post.session.id, "twitter");
    await type(container.querySelector("textarea")!, "Half a thread");
    await type(container.querySelector<HTMLInputElement>(`input[aria-label="${en.feedPage.postEditor.editTitle}"]`)!, "A new title");
    await remount(); await render(post.session.id, "twitter");
    expect(container.querySelector("textarea")?.value).toBe("Half a thread");
    expect(container.querySelector<HTMLInputElement>(`input[aria-label="${en.feedPage.postEditor.editTitle}"]`)?.value).toBe("A new title");
    expect((await readLocalFeedPost("assistant-1", post.session.id))?.content.threadSegments).toEqual(["Half a thread", ""]);
  });
});
