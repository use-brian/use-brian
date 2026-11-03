// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveSessionItem, LiveWorkItem } from "@/lib/api/live";
import { beginChatSendFeedback, useChatLiveCount } from "../chat-send-feedback";

const viewer = vi.hoisted(() => ({ id: "viewer-1" }));
vi.mock("@/lib/user", () => ({ getUserInfo: () => viewer }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const sends: ReturnType<typeof beginChatSendFeedback>[] = [];
const begin = (id: string | null) => {
  const send = beginChatSendFeedback("workspace-1", id); sends.push(send); return send;
};
const row = (state: "working" | "settled" = "working"): LiveSessionItem => ({
  kind: "session", tier: "full", id: "chat-1", assistantId: "assistant-1", assistantName: "Helper",
  assistantIconSeed: 0, ownerUserId: "viewer-1", ownerName: "Viewer", channelType: "web", state,
  startedAt: "2026-11-01T00:00:00Z", lastActiveAt: "2026-11-01T00:00:00Z",
});
function Probe({ workspace = "workspace-1", items = [] }: { workspace?: string; items?: LiveWorkItem[] }) {
  return <output>{useChatLiveCount(workspace, items)}</output>;
}
async function render(items: LiveWorkItem[] = [], workspace?: string) {
  if (!container) { container = document.createElement("div"); root = createRoot(container); }
  await act(async () => root.render(<Probe items={items} workspace={workspace} />));
}
afterEach(async () => {
  await act(async () => { sends.splice(0).forEach(send => send.release()); root?.unmount(); });
  container = undefined!; viewer.id = "viewer-1";
});

describe("[COMP:app-web/chat-send-feedback] immediate Live badge", () => {
  it("paints before a response, adopts a fresh ID without double counting, and releases on failure", async () => {
    await render();
    let send!: ReturnType<typeof begin>;
    await act(async () => { send = begin(null); });
    expect(container.textContent).toBe("1");
    await act(async () => send.adopt("chat-1"));
    await render([row()]);
    expect(container.textContent).toBe("1");
    await render([row("settled")]);
    expect(container.textContent).toBe("1");
    await act(async () => send.release());
    expect(container.textContent).toBe("0");
  });

  it("isolates viewer/workspace and late cleanup from a successor send", async () => {
    const first = begin("chat-1"), successor = begin("chat-1");
    await render();
    expect(container.textContent).toBe("1");
    await act(async () => { first.release(); first.release(); first.adopt("chat-2"); });
    expect(container.textContent).toBe("1");
    await render([], "workspace-2");
    expect(container.textContent).toBe("0");
    viewer.id = "viewer-2";
    await render();
    expect(container.textContent).toBe("0");
    viewer.id = "viewer-1";
    await render();
    await act(async () => successor.release());
    expect(container.textContent).toBe("0");
  });

  it("clears completed work immediately even while an older roster still says running", async () => {
    const send = begin("finished-chat");
    const running = { ...row(), id: "finished-chat", statusReadStartedAt: Date.now() - 1000 };
    await render([running]);
    expect(container.textContent).toBe("1");
    await act(async () => send.complete());
    expect(container.textContent).toBe("0");
    // A late response from the old read must not resurrect the badge.
    await render([{ ...running }]);
    expect(container.textContent).toBe("0");
    await render([{ ...running, statusReadStartedAt: Date.now() + 1000 }]);
    expect(container.textContent).toBe("1");
    await act(async () => { begin("finished-chat"); });
    await render([running]);
    expect(container.textContent).toBe("1");
  });

  it("preserves unrelated server work when local work settles", async () => {
    const send = begin("chat-2");
    await render([row()]);
    expect(container.textContent).toBe("2");
    await act(async () => send.release());
    expect(container.textContent).toBe("1");
  });
});
