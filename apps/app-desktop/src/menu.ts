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
  /** Whether DevTools / reload affordances should be shown (dev only). */
  isDev: boolean;
  /** The auto-update item state, or null to omit it (auto-update disabled). */
  update: { readonly label: string; readonly enabled: boolean } | null;
}

export function buildAppMenu(handlers: MenuHandlers): Menu {
  const template = buildMenuTemplate(
    {
      isMac: process.platform === "darwin",
      isDev: handlers.isDev,
      appName: app.name,
      update: handlers.update,
    },
    handlers,
  );
  return Menu.buildFromTemplate(template);
}
