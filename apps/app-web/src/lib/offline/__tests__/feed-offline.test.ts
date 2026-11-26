import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ data: new Map<string, unknown>(), owner: "viewer-a", quota: false }));
vi.mock("@/lib/user", () => ({ getUserInfo: () => ({ id: state.owner }) }));
vi.mock("../idb", async importOriginal => ({
  ...await importOriginal<typeof import("../idb")>(),
  idbGet: async (key: string) => structuredClone(state.data.get(key) ?? null),
  idbSet: async (key: string, value: unknown) => { state.data.set(key, structuredClone(value)); },
  idbDelete: async (key: string) => { state.data.delete(key); },
  idbUpdate: async (key: string, update: (v: unknown) => unknown) => {
    if (state.quota) throw new Error("quota");
    const next = update(structuredClone(state.data.get(key) ?? null));
    state.data.set(key, structuredClone(next)); return next;
  },
}));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));
import { authFetch } from "@/lib/auth-fetch";
import { feedCachedJson } from "../feed-cache";
import { fetchFeedDraftSessions } from "@/lib/api/feed";
import { blankFeedContent, createLocalFeedPost, patchFeedWorkingCopy, readLocalFeedPost,
  readLocalFeedPosts, flushFeedWorkingCopies, forkLocalFeedPost, loadFeedWorkingCopy,
  readFeedNewPostForm, writeFeedNewPostForm, ensureFeedComposition, retryFeedWorkingCopy } from "../feed-offline";

const assistant = "assistant-1";
const content = () => ({ ...blankFeedContent(), title: "Launch notes", text: "First paragraph" });
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function syncReply(_url: unknown, init?: RequestInit) {
  const request = JSON.parse(init!.body as string);
  return Promise.resolve(reply({ copy: { ...request, revision: request.revision + 1 } }));
}
beforeEach(() => {
  state.data.clear(); state.owner = "viewer-a"; state.quota = false;
  vi.stubGlobal("navigator", { onLine: false });
  vi.mocked(authFetch).mockReset();
});

describe("[COMP:app-web/feed-offline] durable authoring and replay", () => {
  it("creates and reloads an offline post and lists it without a network", async () => {
    const post = await createLocalFeedPost(assistant, "threads", content());
    expect((await fetchFeedDraftSessions(assistant, "threads"))[0].id).toBe(post.session.id);
    await patchFeedWorkingCopy(assistant, post.session.id, { text: "", postFormat: "thread", threadSegments: ["Partial", ""] });
    const restored = await readLocalFeedPost(assistant, post.session.id);
    expect(restored?.content).toMatchObject({ text: "", title: "Launch notes", threadSegments: ["Partial", ""] });
    expect(authFetch).not.toHaveBeenCalled();
  });
  it("persists incomplete new-post forms and isolates viewers", async () => {
    await writeFeedNewPostForm(assistant, "linkedin", { ...content(), privateBrief: "An unfinished thought" });
    expect((await readFeedNewPostForm(assistant, "linkedin"))?.privateBrief).toBe("An unfinished thought");
    await createLocalFeedPost(assistant, "threads", content());
    state.owner = "viewer-b";
    expect(await readLocalFeedPosts()).toEqual([]);
    expect(await readFeedNewPostForm(assistant, "linkedin")).toBeNull();
  });
  it("does not claim a save or create when device storage rejects the write", async () => {
    state.quota = true;
    await expect(createLocalFeedPost(assistant, "threads", content())).rejects.toThrow("quota");
    expect(await readLocalFeedPosts()).toEqual([]);
  });
  it("syncs a closed editor's new post on online startup", async () => {
    const post = await createLocalFeedPost(assistant, "threads", content());
    vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(authFetch).mockImplementation(syncReply);
    await flushFeedWorkingCopies();
    expect(authFetch).toHaveBeenCalledWith(expect.stringContaining(post.session.id), expect.objectContaining({ method: "PUT" }));
    expect(await readLocalFeedPost(assistant, post.session.id)).toMatchObject({ dirty: false, newSession: false, revision: 1 });
    await flushFeedWorkingCopies();
    expect(authFetch).toHaveBeenCalledOnce();
  });
  it("retains edits made during a flush and syncs the next revision", async () => {
    const post = await createLocalFeedPost(assistant, "threads", content());
    vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(authFetch).mockImplementationOnce(async (url, init) => {
      await patchFeedWorkingCopy(assistant, post.session.id, { text: "Newer keystrokes" });
      return syncReply(url, init);
    }).mockImplementation(syncReply);
    await flushFeedWorkingCopies();
    expect(await readLocalFeedPost(assistant, post.session.id)).toMatchObject({ dirty: true, revision: 1, content: { text: "Newer keystrokes" } });
    await flushFeedWorkingCopies();
    expect(await readLocalFeedPost(assistant, post.session.id)).toMatchObject({ dirty: false, revision: 2 });
  });
  it("retries the same persisted mutation after a lost response, even after more editing", async () => {
    const post = await createLocalFeedPost(assistant, "threads", content());
    vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(authFetch).mockRejectedValueOnce(new TypeError("response lost")).mockImplementation(syncReply);
    await flushFeedWorkingCopies();
    const sent = vi.mocked(authFetch).mock.calls[0][1]?.body;
    await patchFeedWorkingCopy(assistant, post.session.id, { text: "After the lost response" });
    await flushFeedWorkingCopies();
    expect(vi.mocked(authFetch).mock.calls[1][1]?.body).toBe(sent);
    expect((await readLocalFeedPost(assistant, post.session.id))?.dirty).toBe(true);
    await flushFeedWorkingCopies();
    expect(await readLocalFeedPost(assistant, post.session.id)).toMatchObject({ dirty: false, revision: 2, content: { text: "After the lost response" } });
  });
  it("keeps conflicts for recovery and copies local work to a separate post", async () => {
    const post = await createLocalFeedPost(assistant, "threads", content());
    vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(authFetch).mockResolvedValue(reply({}, 409));
    await flushFeedWorkingCopies(); await flushFeedWorkingCopies();
    expect(authFetch).toHaveBeenCalledOnce();
    const conflict = (await readLocalFeedPost(assistant, post.session.id))!;
    expect(conflict).toMatchObject({ dirty: true, error: "conflict" });
    const recovered = await forkLocalFeedPost(conflict);
    expect(recovered.session.id).not.toBe(post.session.id);
    expect(recovered.content).toEqual(post.content);
    expect(await readLocalFeedPost(assistant, post.session.id)).toBeNull();
  });
  it("retains work on denied permission and never writes using a changed viewer", async () => {
    const post = await createLocalFeedPost(assistant, "threads", content());
    vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(authFetch).mockResolvedValueOnce(reply({}, 403));
    await flushFeedWorkingCopies();
    expect(await readLocalFeedPost(assistant, post.session.id)).toMatchObject({ dirty: true, error: "blocked" });
    state.owner = "viewer-b";
    await flushFeedWorkingCopies();
    expect(authFetch).toHaveBeenCalledOnce();
  });
  it("restores an existing remote working copy but never replaces unsynced typing", async () => {
    const post = await createLocalFeedPost(assistant, "threads", content());
    vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(authFetch).mockImplementation(syncReply);
    await flushFeedWorkingCopies();
    vi.mocked(authFetch).mockResolvedValue(reply({ copy: { revision: 2, mutationId: "remote", content: { ...content(), text: "From another device" } } }));
    expect((await loadFeedWorkingCopy(assistant, post.session, content())).content.text).toBe("From another device");
    await patchFeedWorkingCopy(assistant, post.session.id, { text: "Local unfinished revision" });
    expect((await loadFeedWorkingCopy(assistant, post.session, content())).content.text).toBe("Local unfinished revision");
  });
  it("keeps a later list denial in force when an earlier grant arrives late", async () => {
    const post = await createLocalFeedPost(assistant, "threads", content());
    vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(authFetch).mockImplementationOnce(syncReply);
    await flushFeedWorkingCopies();
    await patchFeedWorkingCopy(assistant, post.session.id, { text: "Still on this device" });
    let grant!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { grant = resolve; });
    vi.mocked(authFetch).mockImplementationOnce(() => pending);
    const older = fetchFeedDraftSessions(assistant, "threads", true);
    await vi.waitFor(() => expect(authFetch).toHaveBeenCalledTimes(2));
    vi.mocked(authFetch).mockResolvedValueOnce(reply({ sessions: [] }));
    expect(await fetchFeedDraftSessions(assistant, "threads", true)).toEqual([]);
    grant(reply({ sessions: [post.session] }));
    // A superseded read can reject or settle without any admitted rows.
    expect(await older.catch(() => [])).toEqual([]);
    vi.mocked(authFetch).mockClear();
    await flushFeedWorkingCopies();
    expect(authFetch).not.toHaveBeenCalled();
    expect((await readLocalFeedPost(assistant, post.session.id))?.content.text).toBe("Still on this device");
    vi.mocked(authFetch).mockResolvedValueOnce(reply({ sessions: [post.session] }));
    expect((await fetchFeedDraftSessions(assistant, "threads", true)).map(row => row.id)).toEqual([post.session.id]);
    vi.mocked(authFetch).mockImplementation(syncReply);
    await flushFeedWorkingCopies();
    expect(await readLocalFeedPost(assistant, post.session.id)).toMatchObject({ dirty: false, content: { text: "Still on this device" } });
  });
  it("caches reads for airplane navigation but evicts an authoritative access denial", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(authFetch).mockResolvedValueOnce(reply({ name: "Demo workspace" }));
    await feedCachedJson("/api/workspaces/workspace-1");
    vi.stubGlobal("navigator", { onLine: false });
    expect(await feedCachedJson("/api/workspaces/workspace-1")).toEqual({ name: "Demo workspace" });
    vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(authFetch).mockResolvedValueOnce(reply({}, 403));
    await expect(feedCachedJson("/api/workspaces/workspace-1")).rejects.toThrow("403");
    vi.stubGlobal("navigator", { onLine: false });
    await expect(feedCachedJson("/api/workspaces/workspace-1")).rejects.toThrow();
  });
});

// Command replay is exercised through the same persisted record and driver as
// legacy authoring; transport replies are the only replacement boundary here.
import { queueFeedCommands, setFeedDetailAccess } from '../feed-offline';
import { applyFeedEdits, proposeFeedReplacement, projectFeed, walkFeed } from '@use-brian/doc-model';
async function structuredPost() {
  const post = await createLocalFeedPost(assistant, 'threads', content());
  vi.stubGlobal('navigator', { onLine: true });
  vi.mocked(authFetch).mockImplementation(syncReply);
  await flushFeedWorkingCopies();
  const upgraded = await queueFeedCommands(assistant, post.session.id, [{ kind: 'upgrade', seed: crypto.randomUUID() }]);
  vi.mocked(authFetch).mockImplementation(commandReply);
  await flushFeedWorkingCopies();
  return (await readLocalFeedPost(assistant, upgraded.session.id))!;
}
function commandReply(_url: unknown, init?: RequestInit) {
  const request = JSON.parse(init!.body as string);
  return Promise.resolve(reply({ receipt: { mutationId: request.mutationId, revision: request.expectedRevision + request.commands.filter((c: {kind: string}) => ['upgrade', 'edit', 'context'].includes(c.kind)).length, sequence: 0, threadIds: [], suggestionIds: [] } }));
}
describe('[COMP:app-web/feed-offline] automatic composition preparation', () => {
  it.each([400, 403, 404, 409])('resumes only access-rejected mutations after both live read grants (%s)', async status => {
    const post = await structuredPost();
    const id = post.session.id;
    await queueFeedCommands(assistant, id, [{ kind: 'context', title: 'Retained offline title' }]);
    vi.mocked(authFetch).mockReset().mockResolvedValueOnce(reply({ error: 'rejected_edit' }, status));
    await flushFeedWorkingCopies();
    const firstRequest = vi.mocked(authFetch).mock.calls[0]![1]!.body;
    const started = () => performance.timeOrigin + performance.now();
    await setFeedDetailAccess(state.owner, assistant, id, true, started());
    vi.mocked(authFetch).mockResolvedValueOnce(reply({ sessions: [] }));
    expect(await fetchFeedDraftSessions(assistant, 'threads', true)).toEqual([]);
    vi.stubGlobal('navigator', { onLine: false });
    expect((await readLocalFeedPost(assistant, id))?.content.title).toBe('Retained offline title');
    vi.stubGlobal('navigator', { onLine: true });
    vi.mocked(authFetch).mockResolvedValueOnce(reply({ sessions: [post.session] }));
    expect(await fetchFeedDraftSessions(assistant, 'threads', true)).toEqual([]);
    vi.mocked(authFetch).mockClear().mockImplementation(commandReply);
    await flushFeedWorkingCopies();
    expect(authFetch).not.toHaveBeenCalled();
    await setFeedDetailAccess(state.owner, assistant, id, false, started());
    await flushFeedWorkingCopies();
    await flushFeedWorkingCopies();
    if (status === 403 || status === 404) {
      expect(authFetch).toHaveBeenCalledOnce();
      expect(vi.mocked(authFetch).mock.calls[0]![1]!.body).toBe(firstRequest);
      expect(await readLocalFeedPost(assistant, id)).toMatchObject({ dirty: false, content: { title: 'Retained offline title' } });
    } else {
      expect(authFetch).not.toHaveBeenCalled();
      expect(await readLocalFeedPost(assistant, id)).toMatchObject({ dirty: true, error: status === 409 ? 'conflict' : 'blocked' });
    }
  });
  it.each([400, 403, 404, 409])('explicitly retries a rejected command (%s) without changing its payload or losing later local edits', async status => {
    const post = await structuredPost();
    await queueFeedCommands(assistant, post.session.id, [{ kind: 'context', title: 'First title' }]);
    vi.mocked(authFetch).mockReset().mockResolvedValue(reply({ error: 'rejected_edit' }, status));
    await flushFeedWorkingCopies();
    const rejected = vi.mocked(authFetch).mock.calls[0][1]!.body;
    await queueFeedCommands(assistant, post.session.id, [{ kind: 'context', title: 'Later title' }]);
    await flushFeedWorkingCopies(); expect(authFetch).toHaveBeenCalledOnce();
    vi.mocked(authFetch).mockImplementation(commandReply);
    await retryFeedWorkingCopy(assistant, post.session.id);
    expect(vi.mocked(authFetch).mock.calls[1][1]!.body).toBe(rejected);
    expect(authFetch).toHaveBeenCalledTimes(3);
    expect(await readLocalFeedPost(assistant, post.session.id)).toMatchObject({ dirty: false, revision: post.revision + 2, content: { title: 'Later title' }, collaborationQueue: [] });
  });
  it('keeps a true conflict paused after explicit retry and does not rebase or overwrite it', async () => {
    const post = await structuredPost();
    await queueFeedCommands(assistant, post.session.id, [{ kind: 'context', title: 'Local title' }]);
    vi.mocked(authFetch).mockReset().mockResolvedValue(reply({ error: 'revision_conflict' }, 409));
    await flushFeedWorkingCopies();
    const rejected = vi.mocked(authFetch).mock.calls[0][1]!.body;
    await retryFeedWorkingCopy(assistant, post.session.id);
    await flushFeedWorkingCopies();
    expect(authFetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(authFetch).mock.calls[1][1]!.body).toBe(rejected);
    expect(await readLocalFeedPost(assistant, post.session.id)).toMatchObject({ dirty: true, error: 'conflict', revision: post.revision, content: { title: 'Local title' } });
    vi.stubGlobal('navigator', { onLine: false });
    await retryFeedWorkingCopy(assistant, post.session.id);
    expect(authFetch).toHaveBeenCalledTimes(2);
  });

  function transport(url: unknown, init?: RequestInit) {
    return String(url).endsWith('/commands') ? commandReply(url, init) : syncReply(url, init);
  }
  const displayed = (post: Awaited<ReturnType<typeof createLocalFeedPost>>) => ({ mutationId: post.mutationId, text: post.content.text });
  it.each(['post', 'thread', 'article'] as const)('syncs and imports an existing %s without losing its content or context', async postFormat => {
    const source = { ...content(), postFormat, text: '# Notes\n\n**Keep** the detail.', threadSegments: ['First', 'Second'], article: { sourceUrl: 'https://example.com/story', title: 'A story', description: 'Context' } };
    const post = await createLocalFeedPost(assistant, 'linkedin', source);
    vi.stubGlobal('navigator', { onLine: true });
    vi.mocked(authFetch).mockImplementation(transport);
    await flushFeedWorkingCopies();
    await ensureFeedComposition(assistant, post.session.id, displayed(post));
    const upgraded = (await readLocalFeedPost(assistant, post.session.id))!;
    expect(upgraded).toMatchObject({ revision: 2, dirty: false, content: { schemaVersion: 2, title: source.title, article: source.article, postFormat } });
    expect(upgraded.content.text).toBe(postFormat === 'thread' ? 'First\n\nSecond' : source.text);
    const bodies = vi.mocked(authFetch).mock.calls.map(([, init]) => JSON.parse(init!.body as string));
    expect(bodies[1].commands).toEqual([{ kind: 'upgrade', seed: expect.any(String) }]);
    expect(bodies[1].expectedRevision).toBe(1);
  });
  it('creates a missing working-copy row from the visible proposal before upgrading', async () => {
    const post = await createLocalFeedPost(assistant, 'threads', blankFeedContent());
    const records = state.data.get('feed:working:viewer-a') as Record<string, typeof post>;
    Object.assign(records[`${assistant}:${post.session.id}`], { dirty: false, newSession: false });
    vi.stubGlobal('navigator', { onLine: true }); vi.mocked(authFetch).mockImplementation(transport);
    await ensureFeedComposition(assistant, post.session.id, { mutationId: post.mutationId, text: 'The displayed proposal' });
    expect((await readLocalFeedPost(assistant, post.session.id))?.content.text).toBe('The displayed proposal');
    expect(vi.mocked(authFetch).mock.calls.map(([, init]) => init?.method)).toEqual(['PUT', 'POST']);
  });
  it('preserves intentional empty text and newer typing instead of importing stale display state', async () => {
    const post = await createLocalFeedPost(assistant, 'threads', content());
    await patchFeedWorkingCopy(assistant, post.session.id, { text: '' });
    vi.stubGlobal('navigator', { onLine: true }); vi.mocked(authFetch).mockImplementation(transport);
    await ensureFeedComposition(assistant, post.session.id, { mutationId: post.mutationId, text: 'Stale proposal' });
    expect((await readLocalFeedPost(assistant, post.session.id))?.content.text).toBe('');
  });
  it('waits for edits made during a legacy flush instead of upgrading an older acknowledged snapshot', async () => {
    const post = await createLocalFeedPost(assistant, 'threads', content());
    vi.stubGlobal('navigator', { onLine: true });
    vi.mocked(authFetch).mockImplementationOnce(async (url, init) => {
      await patchFeedWorkingCopy(assistant, post.session.id, { text: 'Typed during sync' });
      return syncReply(url, init);
    }).mockImplementation(transport);
    await ensureFeedComposition(assistant, post.session.id, displayed(post));
    const pending = (await readLocalFeedPost(assistant, post.session.id))!;
    expect(pending).toMatchObject({ dirty: true, content: { text: 'Typed during sync' } });
    expect(pending.content.schemaVersion).toBeUndefined();
    await ensureFeedComposition(assistant, post.session.id, displayed(pending));
    expect(await readLocalFeedPost(assistant, post.session.id)).toMatchObject({ dirty: false, content: { schemaVersion: 2, text: 'Typed during sync' } });
  });
  it('converges simultaneous opens on one upgrade and keeps existing structured IDs on later opens', async () => {
    const post = await createLocalFeedPost(assistant, 'threads', content());
    vi.stubGlobal('navigator', { onLine: true }); vi.mocked(authFetch).mockImplementation(transport);
    await Promise.all([ensureFeedComposition(assistant, post.session.id, displayed(post)), ensureFeedComposition(assistant, post.session.id, displayed(post))]);
    const first = await readLocalFeedPost(assistant, post.session.id);
    await ensureFeedComposition(assistant, post.session.id, displayed(post));
    expect((await readLocalFeedPost(assistant, post.session.id))?.content.composition).toEqual(first?.content.composition);
    expect(vi.mocked(authFetch).mock.calls.filter(([url]) => String(url).endsWith('/commands'))).toHaveLength(1);
  });
  it('keeps offline and permission-denied work intact without an upgrade request', async () => {
    const post = await createLocalFeedPost(assistant, 'threads', content());
    await ensureFeedComposition(assistant, post.session.id, displayed(post));
    expect(authFetch).not.toHaveBeenCalled();
    vi.stubGlobal('navigator', { onLine: true }); vi.mocked(authFetch).mockResolvedValue(reply({}, 403));
    await ensureFeedComposition(assistant, post.session.id, displayed(post));
    expect(await readLocalFeedPost(assistant, post.session.id)).toMatchObject({ dirty: true, error: 'blocked', content: { text: post.content.text } });
    expect(vi.mocked(authFetch).mock.calls.every(([, init]) => init?.method === 'PUT')).toBe(true);
  });
});
describe('[COMP:app-web/feed-offline] structured collaboration replay', () => {
  it('scenario 6: persists exact commands across a lost response while retaining newer edits', async () => {
    const post = await structuredPost();
    const first = proposeFeedReplacement(post.content.composition!, { kind: 'post' }, 'First change');
    const local = await queueFeedCommands(assistant, post.session.id, [{ kind: 'edit', edits: first }]);
    vi.mocked(authFetch).mockClear().mockRejectedValueOnce(new TypeError('lost reply')).mockImplementation(commandReply);
    await flushFeedWorkingCopies(); const sent = vi.mocked(authFetch).mock.calls[0]![1]!.body;
    const second = proposeFeedReplacement(local.content.composition!, { kind: 'post' }, 'Newer change');
    await queueFeedCommands(assistant, post.session.id, [{ kind: 'edit', edits: second }]);
    await flushFeedWorkingCopies();
    expect(vi.mocked(authFetch).mock.calls[1]![1]!.body).toBe(sent);
    expect(await readLocalFeedPost(assistant, post.session.id)).toMatchObject({ revision: 4, dirty: false, content: { text: 'Newer change' } });
  });
  it('scenario 6: conflict recovery carries intentional slots into a new typed draft', async () => {
    const post = await structuredPost(); const segment = post.content.composition!.segments[0]!;
    await queueFeedCommands(assistant, post.session.id, [{ kind: 'edit', edits: [{ kind: 'insertBlock', segmentId: segment.id, afterId: segment.content[0]!.attrs.id, node: { type: 'generationPlaceholder', attrs: { id: crypto.randomUUID(), kind: 'image', brief: 'Keep this intent', briefRevision: 2, references: [] } } }] }]);
    vi.mocked(authFetch).mockResolvedValueOnce(reply({}, 409)); await flushFeedWorkingCopies();
    const conflict = (await readLocalFeedPost(assistant, post.session.id))!;
    const copy = await forkLocalFeedPost(conflict);
    expect(projectFeed(copy.content.composition!).missingSlots).toHaveLength(1);
    expect(projectFeed(copy.content.composition!).missingSlots).not.toEqual(projectFeed(conflict.content.composition!).missingSlots);
    vi.mocked(authFetch).mockClear().mockImplementationOnce(syncReply).mockImplementation(commandReply);
    await flushFeedWorkingCopies();
    const creation = JSON.parse(vi.mocked(authFetch).mock.calls[0]![1]!.body as string);
    expect(creation.content.schemaVersion).toBeUndefined(); expect(creation.content.text).not.toContain('Keep this intent');
    await flushFeedWorkingCopies();
    const replayed = (await readLocalFeedPost(assistant, copy.session.id))!;
    expect(replayed.dirty).toBe(false); expect(replayed.content.schemaVersion).toBe(2);
    expect(walkFeed(replayed.content.composition!).some(row => row.node.type === 'generationPlaceholder' && row.node.attrs.brief === 'Keep this intent')).toBe(true);
    expect(await readLocalFeedPost(assistant, post.session.id)).toBeNull();
  });
  it('scenario 6: context controls use commands and refuse to replace the canonical tree', async () => {
    const post = await structuredPost();
    vi.stubGlobal('navigator', { onLine: false });
    const updated = await patchFeedWorkingCopy(assistant, post.session.id, { title: 'A renamed post', privateBrief: 'Context only' });
    expect(updated.content.composition).toEqual(post.content.composition);
    expect(updated.collaborationQueue?.[0]?.commands).toEqual([{ kind: 'context', title: 'A renamed post', privateBrief: 'Context only' }]);
  });
});


describe('[COMP:app-web/feed-offline] selected-source recovery', () => {
  it('retains the source error and retries the identical mutation with server sensitivity', async () => {
    const post = await structuredPost();
    await queueFeedCommands(assistant, post.session.id, [{ kind: 'context', title: 'Selected reference draft' }]);
    vi.mocked(authFetch).mockReset().mockResolvedValue(reply({ error: 'file_not_available_to_draft' }, 403));
    await flushFeedWorkingCopies();
    const rejected = vi.mocked(authFetch).mock.calls[0][1]!.body;
    expect(await readLocalFeedPost(assistant, post.session.id)).toMatchObject({ dirty: true, error: 'blocked', errorCode: 'file_not_available_to_draft' });
    vi.mocked(authFetch).mockImplementation(async (_url, init) => {
      const request = JSON.parse(init!.body as string);
      return reply({ receipt: { mutationId: request.mutationId, revision: request.expectedRevision + 1, sequence: 0, threadIds: [], suggestionIds: [] }, sourceSensitivity: 'internal' });
    });
    await retryFeedWorkingCopy(assistant, post.session.id);
    expect(vi.mocked(authFetch).mock.calls[1][1]!.body).toBe(rejected);
    const synced = await readLocalFeedPost(assistant, post.session.id);
    expect(synced).toMatchObject({ dirty: false, content: { title: 'Selected reference draft', sourceSensitivity: 'internal' } });
    expect(synced?.errorCode).toBeUndefined();
    const fork = await forkLocalFeedPost(synced!);
    expect(fork.content.sourceSensitivity).toBe('internal');
  });
});
