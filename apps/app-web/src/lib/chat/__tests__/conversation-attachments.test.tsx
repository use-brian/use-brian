// @vitest-environment jsdom
/**
 * [COMP:app-web/conversation-attachments] Composer attachment trays beside the
 * conversation registry: chips survive the presentation unmounting, are shared
 * by every mounted presentation of one composer, follow session adoption,
 * stay bounded and are dropped on identity change.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFileAttachments, type Attachment } from "@/lib/use-file-attachments";
import {
  conversationAttachmentKey,
  conversationAttachmentTray,
  createConversationAttachmentStore,
  installAttachmentIdentityHooks,
  type AttachmentTray,
} from "../conversation-attachments";

const { authFetch, authority } = vi.hoisted(() => ({
  authFetch: vi.fn(),
  authority: { current: null as null | { viewerId: string; workspaceId: string; apiOrigin: string; applicationId: string } },
}));
vi.mock("@/lib/auth-fetch", () => ({ authFetch }));
vi.mock("@/lib/runtime-public-config", () => ({ publicRuntimeConfig: () => ({ apiUrl: "https://api.example" }) }));
vi.mock("@/lib/i18n/client", () => ({ useT: () => ({ attachments: {} }) }));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
vi.mock("@/lib/user", () => ({ getUserInfo: () => null, subscribeUserInfo: () => () => {} }));
vi.mock("@/lib/desktop-auth-source", () => ({ desktopBridge: () => null }));
vi.mock("@/lib/offline/application-write-authority", () => ({
  currentOfflineWriteAuthority: () => authority.current,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SCOPE = { apiOrigin: "https://api.example", viewerId: "viewer-1", workspaceId: "workspace-1" };
const OTHER = { ...SCOPE, viewerId: "viewer-2" };
const FRESH = { provisional: "new:page:fresh:personal" };
const SESSION = { sessionId: "s-1" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const response = (id = "file-1", sessionId?: string) => ({ ok: true, json: async () => ({ sessionId, files: [{ id }] }) });
const file = (name = "note.txt") => new File(["hello"], name, { type: "text/plain" });
const ready = (localId: string, previewUrl?: string): Attachment =>
  ({ localId, fileId: `f-${localId}`, fileName: `${localId}.png`, mimeType: "image/png", sizeBytes: 1, status: "done", previewUrl });

type Options = Parameters<typeof useFileAttachments>[1];
type Mount = { root: Root; host: HTMLDivElement; api: () => ReturnType<typeof useFileAttachments>; unmount: () => void };
const mounts: Mount[] = [];

async function mount(options: () => Options): Promise<Mount> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let latest!: ReturnType<typeof useFileAttachments>;
  function Harness() {
    latest = useFileAttachments(undefined, options());
    return null;
  }
  await act(async () => { root.render(createElement(Harness)); });
  const m: Mount = {
    root,
    host,
    api: () => latest,
    unmount: () => { act(() => root.unmount()); host.remove(); mounts.splice(mounts.indexOf(m), 1); },
  };
  mounts.push(m);
  return m;
}

/** A store whose deferred sweep runs only when the test asks. */
function storeWithManualSweep(opts: { cap?: number; identity?: () => { viewerId: string; apiOrigin: string } | null } = {}) {
  const timers: Array<() => void> = [];
  const store = createConversationAttachmentStore({
    cap: opts.cap,
    currentIdentity: opts.identity,
    setTimeout: (callback) => { timers.push(callback); },
  });
  return { store, flush: () => { while (timers.length) timers.shift()!(); } };
}

beforeEach(() => {
  authFetch.mockReset();
  authority.current = null;
  URL.createObjectURL ??= vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  for (const m of [...mounts]) m.unmount();
});

describe("[COMP:app-web/conversation-attachments] tray store", () => {
  it("keys trays with the registry encoding and returns one object per key", () => {
    const { store } = storeWithManualSweep();
    expect(conversationAttachmentKey(SCOPE, SESSION)).toBe(`${JSON.stringify(["https://api.example", "viewer-1", "workspace-1"])}|s:s-1`);
    expect(conversationAttachmentKey(SCOPE, FRESH)).toMatch(/\|p:new:page:fresh:personal$/);
    expect(store.tray(SCOPE, SESSION)).toBe(store.tray(SCOPE, SESSION));
    expect(store.tray(SCOPE, SESSION)).not.toBe(store.tray(OTHER, SESSION));
    expect(store.tray(SCOPE, SESSION)).not.toBe(store.tray(SCOPE, FRESH));
  });

  it("deletes unread empty trays and bounds unread non-empty ones, least recently used first", () => {
    const { store, flush } = storeWithManualSweep({ cap: 2 });
    const trays = ["a", "b", "c"].map((id) => store.tray(SCOPE, { sessionId: id }));
    trays.forEach((tray, i) => tray.update(() => [ready(`chip-${i}`, `blob:${i}`)]));
    store.tray(SCOPE, { sessionId: "empty" });
    flush();
    expect(store.size()).toBe(2);
    expect(trays[0]!.isDisposed()).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:0");
    expect(store.lookup(SCOPE, { sessionId: "b" })?.getSnapshot()).toHaveLength(1);
    expect(store.lookup(SCOPE, { sessionId: "empty" })).toBeNull();
  });

  it("keeps a tray that a reader subscribed to after a sweep removed it while empty", () => {
    const { store, flush } = storeWithManualSweep();
    const tray = store.tray(SCOPE, SESSION);
    flush();
    expect(store.lookup(SCOPE, SESSION)).toBeNull();
    const stop = tray.subscribe(() => {});
    expect(store.lookup(SCOPE, SESSION)).toBe(tray);
    stop();
  });

  it("moves a fresh tray to its session and never merges into a tray holding chips", () => {
    const { store } = storeWithManualSweep();
    const fresh = store.tray(SCOPE, FRESH);
    fresh.update(() => [ready("one")]);
    expect(store.move(SCOPE, FRESH, SESSION)).toBe(true);
    expect(store.tray(SCOPE, SESSION)).toBe(fresh);
    expect(store.tray(SCOPE, FRESH)).not.toBe(fresh);
    const other = store.tray(SCOPE, FRESH);
    other.update(() => [ready("two")]);
    expect(store.move(SCOPE, FRESH, SESSION)).toBe(false);
    expect(store.tray(SCOPE, SESSION).getSnapshot().map((chip) => chip.localId)).toEqual(["one"]);
  });

  it("drops every tray on local-data clear and another identity's trays on reconcile", () => {
    let identity: { viewerId: string; apiOrigin: string } | null = { viewerId: "viewer-1", apiOrigin: SCOPE.apiOrigin };
    const { store } = storeWithManualSweep({ identity: () => identity });
    const mine = store.tray(SCOPE, SESSION);
    const theirs = store.tray(OTHER, SESSION);
    mine.update(() => [ready("mine", "blob:mine")]);
    theirs.update(() => [ready("theirs", "blob:theirs")]);
    const target = new EventTarget();
    const listeners = new Set<() => void>();
    const stop = installAttachmentIdentityHooks(store, {
      target: target as unknown as Window,
      subscribeUser: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    });
    for (const listener of listeners) listener();
    expect(theirs.isDisposed()).toBe(true);
    expect(theirs.getSnapshot()).toEqual([]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:theirs");
    expect(mine.getSnapshot()).toHaveLength(1);
    identity = null;
    target.dispatchEvent(new Event("brian:local-data-cleared"));
    expect(mine.isDisposed()).toBe(true);
    expect(store.size()).toBe(0);
    stop();
  });

  it("binds no tray until the write authority is known", () => {
    const { store } = storeWithManualSweep();
    expect(conversationAttachmentTray("workspace-1", SESSION, store)).toBeNull();
    authority.current = { ...SCOPE, applicationId: "native" };
    expect(conversationAttachmentTray("workspace-1", SESSION, store)).toBe(store.tray(SCOPE, SESSION));
  });
});

describe("[COMP:app-web/conversation-attachments] hook over a tray", () => {
  it("ready chips survive the presentation unmounting and remounting", async () => {
    const { store } = storeWithManualSweep();
    const tray = store.tray(SCOPE, SESSION);
    authFetch.mockResolvedValue(response("file-1"));
    const first = await mount(() => ({ tray }));
    await act(async () => { await first.api().upload([file()]); });
    expect(first.api().fileIds()).toEqual(["file-1"]);
    first.unmount();
    const second = await mount(() => ({ tray: store.tray(SCOPE, SESSION) }));
    expect(second.api().fileIds()).toEqual(["file-1"]);
    expect(second.api().hasReady).toBe(true);
  });

  it("an upload in flight at unmount completes into its tray without adopting a session", async () => {
    const { store } = storeWithManualSweep();
    const tray = store.tray(SCOPE, FRESH);
    const request = deferred<ReturnType<typeof response>>();
    authFetch.mockReturnValueOnce(request.promise);
    const onSessionReady = vi.fn();
    const page = await mount(() => ({ tray, getUploadContext: () => ({ fields: { channelId: "c-1" }, onSessionReady }) }));
    let pending!: Promise<void>;
    await act(async () => { pending = page.api().upload([file()]); });
    expect(tray.getSnapshot()[0]?.status).toBe("uploading");
    page.unmount();
    await act(async () => { request.resolve(response("file-9", "server-session")); await pending; });
    expect(onSessionReady).not.toHaveBeenCalled();
    expect(tray.getSnapshot()).toMatchObject([{ status: "done", fileId: "file-9" }]);
  });

  it("two mounted presentations of one composer share the tray", async () => {
    const { store } = storeWithManualSweep();
    const tray = store.tray(SCOPE, { provisional: "new:dock:doc" });
    authFetch.mockResolvedValue(response("file-2"));
    const dock = await mount(() => ({ tray }));
    const drawer = await mount(() => ({ tray }));
    await act(async () => { await drawer.api().upload([file()]); });
    expect(dock.api().fileIds()).toEqual(["file-2"]);
    await act(async () => { dock.api().detach(); });
    expect(drawer.api().attachments).toEqual([]);
  });

  it("follows the tray a session adoption moved, mid-upload", async () => {
    const { store } = storeWithManualSweep();
    const request = deferred<ReturnType<typeof response>>();
    authFetch.mockReturnValueOnce(request.promise);
    let part: { sessionId: string } | { provisional: string } = FRESH;
    const page = await mount(() => ({
      tray: store.tray(SCOPE, part),
      getUploadContext: () => ({
        fields: { channelId: "c-1" },
        onSessionReady: (id: string) => { store.move(SCOPE, FRESH, { sessionId: id }); part = { sessionId: id }; },
      }),
    }));
    let pending!: Promise<void>;
    await act(async () => { pending = page.api().upload([file()]); });
    await act(async () => { request.resolve(response("file-3", "s-1")); await pending; });
    expect(page.api().fileIds()).toEqual(["file-3"]);
    expect(store.lookup(SCOPE, SESSION)?.getSnapshot()).toHaveLength(1);
    expect(store.tray(SCOPE, FRESH).getSnapshot()).toEqual([]);
  });

  it("a late response never revives a cleared tray", async () => {
    const { store } = storeWithManualSweep();
    const tray = store.tray(SCOPE, SESSION);
    const request = deferred<ReturnType<typeof response>>();
    authFetch.mockReturnValueOnce(request.promise);
    const page = await mount(() => ({ tray }));
    let pending!: Promise<void>;
    await act(async () => { pending = page.api().upload([file()]); });
    await act(async () => { page.api().clear(); });
    await act(async () => { request.resolve(response("late")); await pending; });
    expect(tray.getSnapshot()).toEqual([]);
  });

  it("a detach captured before a switch empties the tray the send came from", async () => {
    const { store } = storeWithManualSweep();
    const a = store.tray(SCOPE, { sessionId: "a" });
    const b = store.tray(SCOPE, { sessionId: "b" });
    a.update(() => [ready("in-a")]);
    b.update(() => [ready("in-b")]);
    let current: AttachmentTray = a;
    const page = await mount(() => ({ tray: current }));
    const detachFromA = page.api().detach;
    current = b;
    await act(async () => { page.root.render(createElement(() => { useFileAttachments(undefined, { tray: current }); return null; })); });
    await act(async () => { detachFromA(); });
    expect(a.getSnapshot()).toEqual([]);
    expect(b.getSnapshot().map((chip) => chip.localId)).toEqual(["in-b"]);
  });

  it("restores a recovery draft into its own conversation's tray", async () => {
    const { store } = storeWithManualSweep();
    const here = store.tray(SCOPE, SESSION);
    const draftTray = store.tray(SCOPE, FRESH);
    const page = await mount(() => ({ tray: here }));
    await act(async () => { page.api().restore([ready("saved", "blob:stale")], draftTray); });
    expect(here.getSnapshot()).toEqual([]);
    expect(draftTray.getSnapshot()).toEqual([ready("saved")]);
    expect(draftTray.getSnapshot()[0]).not.toHaveProperty("previewUrl");
  });

  it("without a tray, chips stay local to the component and an unmount drops late results", async () => {
    const request = deferred<ReturnType<typeof response>>();
    authFetch.mockReturnValueOnce(request.promise);
    const local = await mount(() => undefined);
    let pending!: Promise<void>;
    await act(async () => { pending = local.api().upload([file()]); });
    const before = local.api().attachments;
    expect(before).toHaveLength(1);
    local.unmount();
    await act(async () => { request.resolve(response("late")); await pending; });
    const again = await mount(() => undefined);
    expect(again.api().attachments).toEqual([]);
  });
});
