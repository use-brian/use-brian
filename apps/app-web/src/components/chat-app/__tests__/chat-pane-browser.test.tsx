// @vitest-environment jsdom
/**
 * [COMP:app-web/chat-side-pane] The `browser` tab: the desktop slot (T7) and
 * the web cloud-browser frame (D10), behind the shell's protocol gate.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";

const bridge = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("@/lib/desktop-auth-source", () => ({ desktopBridge: () => bridge.current }));
const computer = vi.hoisted(() => ({
  getComputerTask: vi.fn(),
  getComputerFrame: vi.fn(),
  resumeComputerTask: vi.fn(async () => {}),
}));
vi.mock("@/lib/api/computer", () => computer);
const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { PaneBrowserBody } from "../chat-pane-browser";
import {
  desktopBrowserPane,
  EMBEDDED_BROWSER_PANE_PROTOCOL,
  isBrowserToolName,
  reportBrowserSlot,
} from "@/lib/desktop-browser-pane";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
async function render(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}>{node}</I18nProvider>);
  });
}
const flushFrames = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

beforeEach(() => {
  bridge.current = null;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
  computer.getComputerTask.mockReset();
  computer.getComputerFrame.mockReset();
});

describe("[COMP:app-web/chat-side-pane] the browser tab", () => {
  it("gates on the shell's exact pane protocol; an older shell keeps its dock", () => {
    bridge.current = { browserControl: vi.fn(async () => ({ ok: true })) };
    expect(desktopBrowserPane()).toBeNull();
    bridge.current = { browserControl: vi.fn(async () => ({ ok: true })), browserPaneProtocol: EMBEDDED_BROWSER_PANE_PROTOCOL };
    expect(desktopBrowserPane()).not.toBeNull();
    reportBrowserSlot("chat-a", { x: 10.4, y: 20.6, width: 300, height: 400 });
    expect((bridge.current.browserControl as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({
      type: "pane-slot", chatKey: "chat-a", rect: { x: 10, y: 21, width: 300, height: 400 },
    });
    expect(isBrowserToolName("browserNavigate")).toBe(true);
    expect(isBrowserToolName("searchKnowledge")).toBe(false);
  });

  it("T7: the desktop slot reports its bounds, hides under a modal, and hides when it goes", async () => {
    const control = vi.fn(async () => ({ ok: true }));
    bridge.current = { browserControl: control, browserPaneProtocol: EMBEDDED_BROWSER_PANE_PROTOCOL };
    await render(<PaneBrowserBody workspaceId="ws" chatKey="chat-a" browserId="tab-1" url="https://a.example/" />);
    await flushFrames();
    expect(host.querySelector("[data-browser-slot]")).not.toBeNull();
    // jsdom lays nothing out: a zero-size slot reports hidden; give it a box.
    const slot = host.querySelector("[data-browser-slot]") as HTMLElement;
    slot.getBoundingClientRect = () => ({ left: 900, top: 64, width: 420, height: 700 }) as DOMRect;
    await act(async () => { window.dispatchEvent(new Event("resize")); });
    await flushFrames();
    expect(control).toHaveBeenLastCalledWith({ type: "pane-slot", chatKey: "chat-a", rect: { x: 900, y: 64, width: 420, height: 700 } });
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    await act(async () => { document.body.appendChild(modal); });
    await flushFrames();
    expect(control).toHaveBeenLastCalledWith({ type: "pane-slot", chatKey: "chat-a", rect: null });
    modal.remove();
    act(() => root.unmount());
    expect(control).toHaveBeenLastCalledWith({ type: "pane-slot", chatKey: "chat-a", rect: null });
  });

  it("D10: on the web, a paused cloud browse shows its last frame with Resume and Open", async () => {
    computer.getComputerTask.mockResolvedValue({ taskId: "t", status: "paused", backend: "cloud", profileId: null, injectedSite: null, workspaceId: "ws", createdAt: 0 });
    computer.getComputerFrame.mockResolvedValue({ data: "AAAA", mimeType: "image/png" });
    await render(<PaneBrowserBody workspaceId="ws" chatKey="chat-a" browserId="computer:chat-a" url={null} />);
    await flushFrames();
    expect(host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(host.textContent).toContain(en.chatApp.sidePane.browserPaused);
    const resume = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === en.chatApp.sidePane.browserResume);
    await act(async () => resume!.click());
    expect(computer.resumeComputerTask).toHaveBeenCalledWith("chat-a");
    const open = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === en.chatApp.sidePane.browserOpen);
    act(() => open!.click());
    expect(router.push).toHaveBeenCalledWith("/w/ws/computer/chat-a");
  });

  it("D10: an ended browse keeps the last frame it showed", async () => {
    computer.getComputerTask.mockResolvedValue(null);
    await render(<PaneBrowserBody workspaceId="ws" chatKey="chat-a" browserId="computer:chat-a" url={null} />);
    await flushFrames();
    // The frame captured by the previous case survives the tab remounting.
    expect(host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(host.textContent).toContain(en.chatApp.sidePane.browserEnded);
  });
});
