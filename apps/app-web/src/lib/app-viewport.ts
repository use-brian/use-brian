"use client";

import { useSyncExternalStore } from "react";

const DOCK_LAYOUT_EVENT = "usebrian:browser-dock-layout";

function isBrowserDocked(): boolean {
  return typeof document !== "undefined" &&
    document.documentElement.hasAttribute("data-native-browser-docked");
}

/** Layout width, not a responsive breakpoint: native docking leaves innerWidth unchanged. */
export function availableAppWidth(): number {
  if (typeof window === "undefined") return 0;
  if (isBrowserDocked() && document.body) {
    return document.body.clientWidth || document.body.getBoundingClientRect().width;
  }
  return window.innerWidth;
}

export function subscribeAppViewport(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("resize", onChange);
  window.addEventListener(DOCK_LAYOUT_EVENT, onChange);
  return () => {
    window.removeEventListener("resize", onChange);
    window.removeEventListener(DOCK_LAYOUT_EVENT, onChange);
  };
}

/** Undefined preserves Base UI's normal clipping-ancestors boundary on the web. */
export function appPopupBoundary(): HTMLElement | undefined {
  return isBrowserDocked() ? document.body ?? undefined : undefined;
}

function layoutSnapshot(): string {
  return `${isBrowserDocked()}:${availableAppWidth()}`;
}

/** Re-render open positioners on native layout changes as well as real resizes. */
export function useAppPopupBoundary(): HTMLElement | undefined {
  const layout = useSyncExternalStore(subscribeAppViewport, layoutSnapshot, () => "false:0");
  return layout.startsWith("true:") ? appPopupBoundary() : undefined;
}
