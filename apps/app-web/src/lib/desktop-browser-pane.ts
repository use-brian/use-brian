/**
 * The desktop shell's browser, hosted inside the Chat side pane
 * (chat-parity T7).
 *
 * A new desktop shell no longer docks its native browser against the window
 * edge: the pane renders a slot and reports its bounds, and the shell lays
 * the open chat's browser tab into that rect, hiding it whenever the slot is
 * hidden (another tab active, the pane closed, a different chat, a modal
 * open). The shell tells the app which tabs Brian opened, so each lands in
 * its chat's pane as a `browser` tab (D8).
 *
 * Deploy skew: the app is gated on the shell's exact protocol number (the
 * `CURRENT_EXTENSION_BUILD` pattern). An older shell omits it and keeps its
 * native dock; the pane then shows no desktop browser tab and leaves the dock
 * (and its `usebrian:browser-dock-layout` narrowing) alone.
 *
 * Spec: docs/architecture/features/chat-app.md -> "Side pane" -> "Browser tab".
 *
 * [COMP:app-web/chat-side-pane]
 */

import { desktopBridge, type DesktopBridge, type DesktopBrowserPaneEvent } from "./desktop-auth-source";

/** The pane protocol this app speaks; must equal the shell's `browserPaneProtocol`. */
export const EMBEDDED_BROWSER_PANE_PROTOCOL = 1;

/** The shell's bridge when it hosts its browser in the pane, else null (web, or an older shell). */
export function desktopBrowserPane(): DesktopBridge | null {
  const bridge = desktopBridge();
  return bridge?.browserControl && bridge.browserPaneProtocol === EMBEDDED_BROWSER_PANE_PROTOCOL ? bridge : null;
}

export type SlotRect = { x: number; y: number; width: number; height: number };

/** Report the browser slot of `chatKey`'s pane, or null to hide the browser. */
export function reportBrowserSlot(chatKey: string | null, rect: SlotRect | null): void {
  const bridge = desktopBrowserPane();
  if (!bridge) return;
  const clean = rect
    ? {
        x: Math.max(0, Math.round(rect.x)),
        y: Math.max(0, Math.round(rect.y)),
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      }
    : null;
  void bridge.browserControl!({ type: "pane-slot", chatKey, rect: clean }).catch(() => {});
}

/** Report the chat whose turn is live: a task's new browser tabs belong to it. */
export function reportTurnChat(chatKey: string | null): void {
  const bridge = desktopBrowserPane();
  if (!bridge) return;
  void bridge.browserControl!({ type: "pane-chat", chatKey }).catch(() => {});
}

/** Hear the tabs Brian opens in the shell's browser. */
export function subscribeBrowserPane(listener: (event: DesktopBrowserPaneEvent) => void): () => void {
  return desktopBrowserPane()?.onBrowserPane?.(listener) ?? (() => {});
}

/** Tool names whose first call means Brian started browsing (the web pane's cue). */
export function isBrowserToolName(name: string): boolean {
  return /^(browser|computer)/i.test(name) || name === "runBrowserSkill";
}
