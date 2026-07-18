/**
 * Native application menu (the electron binding).
 *
 * The platform-aware menu *template* lives in the pure `menu-template.ts`
 * (unit-tested without Electron). This file is the thin shell: it reads
 * `process.platform` / `app.name` and hands the template to
 * `Menu.buildFromTemplate`, so the menu structure stays tested while only the
 * electron call lives here.
 *
 * Spec: docs/architecture/features/app-desktop.md → "menu.ts"
 * [COMP:app-desktop/menu]
 */

import { Menu, app } from "electron";

import { buildMenuTemplate } from "./menu-template.js";

export interface MenuHandlers {
  /** Summon the window and jump to the quick-capture surface. */
  onQuickCapture: () => void;
  /** Start the system-browser sign-in flow. */
  onSignIn: () => void;
  /** Clear the local session and return to the sign-in screen. */
  onSignOut: () => void;
  /** Perform the current update action (check for updates / restart to install). */
  onUpdate: () => void;
  /** Switch the shell's target (cloud ↔ local brain); persists + relaunches. */
  onSwitchTarget: () => void;
  /** Confirm, tear down local traces, trash the bundle, quit (uninstall.ts). */
  onUninstall: () => void;
  /** Whether DevTools / reload affordances should be shown (dev only). */
  isDev: boolean;
  /** Show "Uninstall …" in the macOS app menu (packaged macOS builds only). */
  uninstall: boolean;
  /** The auto-update item state, or null to omit it (auto-update disabled). */
  update: { readonly label: string; readonly enabled: boolean } | null;
  /** The active target for the indicator + switch items (see menu-template.ts). */
  target: { readonly kind: "cloud" | "local"; readonly label: string } | null;
}

export function buildAppMenu(handlers: MenuHandlers): Menu {
  const template = buildMenuTemplate(
    {
      isMac: process.platform === "darwin",
      isDev: handlers.isDev,
      appName: app.name,
      update: handlers.update,
      target: handlers.target,
      uninstall: handlers.uninstall,
    },
    handlers,
  );
  return Menu.buildFromTemplate(template);
}
