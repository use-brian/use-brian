// @vitest-environment jsdom
/** [COMP:app-web/popover] Open popup boundaries follow native dock transitions. */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useAppPopupBoundary } from "@/lib/app-viewport";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

afterEach(() => {
  document.documentElement.removeAttribute("data-native-browser-docked");
  vi.unstubAllGlobals();
});

it("[COMP:app-web/popover] updates an already mounted boundary on docking and undocking", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const boundaries: (HTMLElement | undefined)[] = [];
  function Probe() {
    boundaries.push(useAppPopupBoundary());
    return null;
  }
  try {
    await act(async () => root.render(<Probe />));
    expect(boundaries.at(-1)).toBeUndefined();
    await act(async () => {
      document.documentElement.setAttribute("data-native-browser-docked", "");
      window.dispatchEvent(new Event("usebrian:browser-dock-layout"));
    });
    expect(boundaries.at(-1)).toBe(document.body);
    await act(async () => {
      document.documentElement.removeAttribute("data-native-browser-docked");
      window.dispatchEvent(new Event("usebrian:browser-dock-layout"));
    });
    expect(boundaries.at(-1)).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
