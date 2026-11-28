import { describe, expect, it, vi } from "vitest";
import { createChatBrowserPreview } from "@/lib/chat-browser-preview";
import type { ComputerTask } from "@/lib/api/computer";

const running: ComputerTask = {
  taskId: "task-a", profileId: "profile-a", workspaceId: "workspace-a",
  backend: "local", status: "running", injectedSite: "example.test", createdAt: 123,
};

function fixture(hasNativePane = false) {
  const lookup = vi.fn<(sessionId: string) => Promise<ComputerTask | null>>();
  lookup.mockResolvedValue(null);
  const open = vi.fn();
  const preview = createChatBrowserPreview({ lookup, open, hasNativePane: () => hasNativePane });
  return { preview, lookup, open };
}

describe("[COMP:app-web/chat-side-pane] browser preview discovery", () => {
  it("re-probes after a browser tool result even if its start probe is still in flight", async () => {
    const { preview, lookup, open } = fixture();
    let finish: (task: ComputerTask | null) => void = () => {};
    lookup.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    lookup.mockResolvedValueOnce(running);
    preview.started("session-a", "tool-1", "browserNavigate");
    const end = preview.settled("session-a", "tool-1");
    expect(lookup).toHaveBeenCalledTimes(1);
    finish(null);
    await end;
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledExactlyOnceWith("session-a", running);
    preview.started("session-a", "tool-2", "browserSnapshot");
    await preview.settled("session-a", "tool-2");
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("ignores non-browser and dropped calls, and keys results by the owning chat", async () => {
    const { preview, lookup, open } = fixture();
    preview.started("session-a", "t1", "webSearch");
    await preview.settled("session-a", "t1");
    expect(lookup).not.toHaveBeenCalled();
    preview.started("session-a", "t2", "browserNavigate");
    await preview.settled("session-b", "t2");
    preview.dropped("session-a", "t2");
    await preview.settled("session-a", "t2");
    expect(lookup).toHaveBeenCalledExactlyOnceWith("session-a");
    expect(open).not.toHaveBeenCalled();
  });

  it("discovers a browser started by a wrapped call without depending on its arguments", async () => {
    const { preview, lookup, open } = fixture();
    preview.started("session-a", "other", "mcp_call");
    await preview.settled("session-a", "other");
    expect(open).not.toHaveBeenCalled();
    lookup.mockResolvedValueOnce(null).mockResolvedValueOnce(running);
    preview.started("session-a", "browser", "mcp_call");
    await preview.settled("session-a", "browser");
    expect(open).toHaveBeenCalledExactlyOnceWith("session-a", running);
  });

  it("leaves local previews to the native desktop pane and does not open an ended task", async () => {
    const { preview, lookup, open } = fixture(true);
    lookup.mockResolvedValueOnce(running).mockResolvedValueOnce({ ...running, backend: "cloud", status: "completed" });
    preview.started("session-a", "t1", "browserNavigate");
    await preview.settled("session-a", "t1");
    expect(open).not.toHaveBeenCalled();
  });
});
