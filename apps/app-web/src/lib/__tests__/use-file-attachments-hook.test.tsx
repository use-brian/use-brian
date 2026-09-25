// @vitest-environment jsdom
/** [COMP:app-web/file-attachments] Multipart session adoption and upload ownership. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFileAttachments } from "../use-file-attachments";

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch }));
vi.mock("@/lib/runtime-public-config", () => ({ publicRuntimeConfig: () => ({ apiUrl: "https://api.test" }) }));
vi.mock("@/lib/i18n/client", () => ({ useT: () => ({ attachments: {} }) }));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type Options = Parameters<typeof useFileAttachments>[1];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function response(sessionId?: string, id = "file-1") {
  return { ok: true, json: async () => ({ sessionId, files: [{ id }] }) };
}
const file = (name = "note.txt") => new File(["hello"], name, { type: "text/plain" });
let root: Root | undefined;
let host: HTMLDivElement;
let latest: ReturnType<typeof useFileAttachments>;
let sessionId: string | undefined;
let options: Options;
function Harness() {
  latest = useFileAttachments(() => sessionId, options);
  return null;
}
async function render() {
  await act(async () => { root!.render(createElement(Harness)); });
}
async function startUpload(name?: string) {
  let pending!: Promise<void>;
  await act(async () => { pending = latest.upload([file(name)]); });
  return { pending };
}
function body(index = 0): FormData {
  return authFetch.mock.calls[index][1].body;
}
beforeEach(async () => {
  authFetch.mockReset();
  sessionId = undefined;
  options = undefined;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await render();
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

describe("[COMP:app-web/file-attachments] hook session adoption", () => {
  it("posts fresh-pane context and adopts response.sessionId before files become sendable", async () => {
    const request = deferred<ReturnType<typeof response>>();
    authFetch.mockReturnValueOnce(request.promise).mockResolvedValue(response("server-session", "file-2"));
    const onSessionReady = vi.fn((id: string) => {
      expect(latest.hasReady).toBe(false);
      expect(latest.fileIds()).toEqual([]);
      sessionId = id;
    });
    const fields = {
      workspaceId: "workspace", assistantId: "assistant", channelId: "fresh-channel",
      appOrigin: "chat", contextGroupId: "team", contextProjectId: "project",
    };
    options = { getUploadContext: () => sessionId ? undefined : { fields, onSessionReady } };
    await render();
    const { pending } = await startUpload();
    expect(authFetch.mock.calls[0][0]).toBe("https://api.test/api/files/upload");
    expect(authFetch.mock.calls[0][1].method).toBe("POST");
    expect(authFetch.mock.calls[0][1].headers).toBeUndefined();
    expect(Object.fromEntries([...body().entries()].filter(([key]) => key !== "files"))).toEqual(fields);
    expect((body().get("files") as File).name).toBe("note.txt");
    expect(latest.uploading).toBe(true);
    expect(onSessionReady).not.toHaveBeenCalled();
    await act(async () => { request.resolve(response("server-session")); await pending; });
    expect(onSessionReady).toHaveBeenCalledExactlyOnceWith("server-session");
    expect(latest.uploading).toBe(false);
    // A host sending as soon as the tray is ready sees the adopted identity.
    expect({ sessionId, fileIds: latest.fileIds() }).toEqual({ sessionId: "server-session", fileIds: ["file-1"] });
    await act(async () => { await latest.upload([file("second.txt")]); });
    expect(body(1).get("sessionId")).toBe("server-session");
    expect(body(1).has("channelId")).toBe(false);
    expect(latest.fileIds()).toEqual(["file-1", "file-2"]);
  });

  it("keeps concurrent batches on the host's stable channel and reconciles out-of-order responses", async () => {
    const first = deferred<ReturnType<typeof response>>();
    const second = deferred<ReturnType<typeof response>>();
    authFetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const onSessionReady = vi.fn((id: string) => { sessionId = id; });
    options = { getUploadContext: () => ({ fields: { channelId: "same-fresh-channel" }, onSessionReady }) };
    await render();
    const stableUpload = latest.upload;
    const a = await startUpload("a.txt");
    const b = await startUpload("b.txt");
    expect(latest.upload).toBe(stableUpload);
    expect([body(0).get("channelId"), body(1).get("channelId")]).toEqual(["same-fresh-channel", "same-fresh-channel"]);
    const localIds = latest.attachments.map((a) => a.localId);
    expect(new Set(localIds).size).toBe(2);
    await act(async () => { second.resolve(response("shared-session", "file-b")); await b.pending; });
    expect(latest.uploading).toBe(true);
    expect(latest.fileIds()).toEqual(["file-b"]);
    await act(async () => { first.resolve(response("shared-session", "file-a")); await a.pending; });
    expect(latest.attachments.map((a) => a.localId)).toEqual(localIds);
    expect(latest.fileIds()).toEqual(["file-a", "file-b"]);
    expect(onSessionReady.mock.calls).toEqual([["shared-session"], ["shared-session"]]);
  });

  it.each(["clear", "detach", "navigation", "unmount"] as const)("%s prevents an old response from adopting a session", async (action) => {
    // Defer JSON too: invalidation must hold after headers have arrived.
    const json = deferred<Awaited<ReturnType<ReturnType<typeof response>["json"]>>>();
    authFetch.mockResolvedValueOnce({ ok: true, json: () => json.promise });
    const oldAdopt = vi.fn();
    const newAdopt = vi.fn();
    options = { getUploadContext: () => ({ fields: { channelId: "old-pane" }, onSessionReady: oldAdopt }) };
    await render();
    const { pending } = await startUpload();
    act(() => {
      if (action === "unmount") { root!.unmount(); root = undefined; }
      else if (action === "detach") latest.detach();
      else latest.clear(); // ChatSurface clears the tray on navigation.
    });
    if (action === "navigation") {
      sessionId = "destination-session";
      options = { getUploadContext: () => ({ fields: {}, onSessionReady: newAdopt }) };
      await render();
      authFetch.mockResolvedValueOnce(response("destination-session", "new-file"));
      await act(async () => { await latest.upload([file("new.txt")]); });
    }
    await act(async () => { json.resolve({ sessionId: "old-session", files: [{ id: "old-file" }] }); await pending; });
    expect(oldAdopt).not.toHaveBeenCalled();
    if (action === "navigation") {
      expect(newAdopt).toHaveBeenCalledExactlyOnceWith("destination-session");
      expect(latest.fileIds()).toEqual(["new-file"]);
      expect(sessionId).toBe("destination-session");
    } else if (action !== "unmount") expect(latest.attachments).toEqual([]);
  });

  it.each(["all", "some"] as const)("removing %s pending chips only adopts if this batch still has chips", async (removal) => {
    const json = deferred<{ sessionId: string; files: { id: string }[] }>();
    authFetch.mockResolvedValueOnce({ ok: true, json: () => json.promise });
    const onSessionReady = vi.fn();
    options = { getUploadContext: () => ({ fields: { channelId: "fresh-pane" }, onSessionReady }) };
    await render();
    let pending!: Promise<void>;
    await act(async () => { pending = latest.upload([file("a.txt"), file("b.txt")]); });
    const [first, second] = latest.attachments;
    expect(latest.uploading).toBe(true);
    act(() => {
      latest.remove(first.localId);
      if (removal === "all") latest.remove(second.localId);
    });
    expect(onSessionReady).not.toHaveBeenCalled();
    await act(async () => {
      json.resolve({ sessionId: "server-session", files: [{ id: "file-a" }, { id: "file-b" }] });
      await pending;
    });
    expect(latest.uploading).toBe(false);
    if (removal === "all") {
      expect(onSessionReady).not.toHaveBeenCalled();
      expect(latest.attachments).toEqual([]);
      expect(latest.fileIds()).toEqual([]);
      expect(latest.hasReady).toBe(false);
    } else {
      expect(onSessionReady).toHaveBeenCalledExactlyOnceWith("server-session");
      expect(latest.attachments.map((chip) => chip.localId)).toEqual([second.localId]);
      expect(latest.fileIds()).toEqual(["file-b"]);
      expect(latest.hasReady).toBe(true);
    }
  });

  it("does not adopt when a legacy response omits sessionId", async () => {
    const onSessionReady = vi.fn();
    options = { getUploadContext: () => ({ fields: {}, onSessionReady }) };
    await render();
    authFetch.mockResolvedValueOnce(response());
    await act(async () => { await latest.upload([file()]); });
    expect(onSessionReady).not.toHaveBeenCalled();
    expect(latest.fileIds()).toEqual(["file-1"]);
  });
});
