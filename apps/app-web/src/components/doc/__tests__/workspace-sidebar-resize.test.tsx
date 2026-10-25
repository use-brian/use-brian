// @vitest-environment jsdom
/** [COMP:app-web/workspace-sidebar-resize] Persistent, bounded shell interaction. */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { useWorkspaceSidebarResize, WorkspaceSidebarResizeHandle } from "../workspace-sidebar-resize";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const KEY = "workspace:sidebar-width:v1";
const wrap = (child: React.ReactNode) => <I18nProvider locale="en" dict={en}>{child}</I18nProvider>;
function Probe({ collapsed = false, app = "Chat" }: { collapsed?: boolean; app?: string }) {
  const resize = useWorkspaceSidebarResize();
  return <div ref={resize.containerRef} style={resize.style} data-resizing={resize.resizing}>
    <span>{app}</span><input aria-label="Draft" defaultValue="Unsent draft" />
    {!collapsed && <WorkspaceSidebarResizeHandle {...resize.handleProps} />}
  </div>;
}

describe("[COMP:app-web/workspace-sidebar-resize] contextual sidebar", () => {
  let host: HTMLDivElement, root: Root;
  let observeResize: () => void;
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.stubGlobal("innerWidth", 1440);
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { observeResize = callback; }
      observe() {} disconnect() {}
    });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); host.remove();
    document.documentElement.style.cursor = "";
    document.documentElement.style.userSelect = "";
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  const separator = () => host.querySelector<HTMLElement>('[role="separator"]')!;
  const width = () => Number(separator().getAttribute("aria-valuenow"));
  async function render(props: { collapsed?: boolean; app?: string } = {}) {
    await act(async () => root.render(wrap(<Probe {...props} />)));
  }
  async function key(value: string, shiftKey = false) {
    await act(async () => separator().dispatchEvent(new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true })));
  }
  function pointer(target: EventTarget, type: string, clientX: number, pointerId = 1, button = 0) {
    const event = new MouseEvent(type, { clientX, button, bubbles: true, cancelable: true });
    Object.defineProperty(event, "pointerId", { value: pointerId });
    target.dispatchEvent(event);
  }

  it("server-renders the default before loading a saved preference after hydration", async () => {
    localStorage.setItem(KEY, "340");
    expect(renderToString(wrap(<Probe />))).toContain("--workspace-sidebar-width:224px");
    await render();
    expect(width()).toBe(340);
    expect(separator().getAttribute("aria-label")).toBe(en.docPage.sidebarResizeAria);
    expect(separator().getAttribute("aria-orientation")).toBe("vertical");
  });

  it("supports keyboard steps, viewport limits and reset without changing the draft", async () => {
    await render();
    const draft = host.querySelector("input")!; draft.value = "Keep this draft";
    await key("ArrowRight"); expect(width()).toBe(234);
    await key("ArrowRight", true); expect(width()).toBe(274);
    await key("ArrowLeft"); expect(width()).toBe(264);
    expect(localStorage.getItem(KEY)).toBe("264");
    await key("Home"); expect(width()).toBe(200);
    await key("ArrowLeft"); expect(width()).toBe(200);
    await key("End"); expect(width()).toBe(420);
    await key("ArrowRight"); expect(width()).toBe(420);
    await key("Enter"); expect(width()).toBe(224);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(draft.value).toBe("Keep this draft");
  });

  it("clamps to container space, then restores the wider preference", async () => {
    localStorage.setItem(KEY, "400"); await render();
    const container = host.firstElementChild!;
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({ width: 768 } as DOMRect);
    await act(async () => observeResize());
    expect(width()).toBe(344);
    expect(separator().getAttribute("aria-valuemax")).toBe("344");
    expect(localStorage.getItem(KEY)).toBe("400");
    vi.mocked(container.getBoundingClientRect).mockReturnValue({ width: 1440 } as DOMRect);
    await act(async () => observeResize());
    expect(width()).toBe(400);
  });

  it("tracks pointer movement and commits the final width even before its animation frame", async () => {
    await render();
    document.documentElement.style.cursor = "crosshair";
    await act(async () => pointer(separator(), "pointerdown", 280));
    expect(document.activeElement).toBe(separator());
    expect(host.firstElementChild?.getAttribute("data-resizing")).toBe("true");
    await act(async () => pointer(window, "pointermove", 330));
    await act(async () => pointer(window, "pointerup", 330));
    expect(width()).toBe(274);
    expect(localStorage.getItem(KEY)).toBe("274");
    expect(document.documentElement.style.cursor).toBe("crosshair");
    expect(document.documentElement.style.userSelect).toBe("");
    await act(async () => vi.runOnlyPendingTimers());
    expect(width()).toBe(274);
  });

  it("ignores unrelated pointers and restores the saved width on cancellation or Escape", async () => {
    localStorage.setItem(KEY, "300"); await render();
    for (const cancel of ["pointercancel", "Escape"]) {
      await act(async () => pointer(separator(), "pointerdown", 356));
      await act(async () => { pointer(window, "pointermove", 500, 9); vi.advanceTimersByTime(20); });
      expect(width()).toBe(300);
      await act(async () => { pointer(window, "pointermove", 416); vi.advanceTimersByTime(20); });
      expect(width()).toBe(360);
      await act(async () => {
        if (cancel === "Escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        else pointer(window, cancel, 416);
      });
      expect(width()).toBe(300);
      expect(localStorage.getItem(KEY)).toBe("300");
      expect(document.documentElement.style.userSelect).toBe("");
    }
  });

  it("preserves width across collapse/app changes, synchronizes storage, and resets on double-click", async () => {
    await render(); await key("ArrowRight", true);
    const draft = host.querySelector("input")!; draft.value = "Still here";
    await render({ collapsed: true }); expect(separator()).toBeNull();
    await render({ app: "Projects" }); expect(width()).toBe(264);
    expect(host.querySelector("input")).toBe(draft); expect(draft.value).toBe("Still here");
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: "360" })));
    expect(width()).toBe(360);
    await act(async () => separator().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(width()).toBe(224); expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("handles invalid or unavailable storage while keeping resizing usable", async () => {
    localStorage.setItem(KEY, "broken"); await render(); expect(width()).toBe(224);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    await key("ArrowRight"); expect(width()).toBe(234);
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: "999999" })));
    expect(width()).toBe(420);
  });

  it("cleans up an active drag on unmount and ignores non-primary-button drags", async () => {
    await render();
    await act(async () => pointer(separator(), "pointerdown", 280, 1, 2));
    expect(document.documentElement.style.cursor).toBe("");
    await act(async () => pointer(separator(), "pointerdown", 280));
    await act(async () => { pointer(window, "pointermove", 500); root.render(null); });
    await act(async () => vi.runOnlyPendingTimers());
    expect(document.documentElement.style.userSelect).toBe("");
    expect(document.documentElement.style.cursor).toBe("");
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
