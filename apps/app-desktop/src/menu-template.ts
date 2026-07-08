/**
 * Application menu *template* — the pure, platform-aware structure.
 *
 * Kept separate from `menu.ts` (the electron binding) so it unit-tests with no
 * Electron: the only electron reference here is the `MenuItemConstructorOptions`
 * TYPE, which is erased at compile time. `menu.ts` reads `process.platform` /
 * `app.name` and hands the result to `Menu.buildFromTemplate`.
 *
 * macOS and Windows differ in two structural ways:
 *  - macOS has an app-name menu carrying about/hide/quit; Windows/Linux have no
 *    app menu, so those actions fold into a "File" menu and the macOS-only roles
 *    (about/hide/hideOthers/unhide/zoom/front) are dropped — Electron would render
 *    them as dead items off-mac.
 *  - The shared "Quick Capture" accelerator uses `CommandOrControl`, which maps to
 *    ⌘ on macOS and Ctrl on Windows automatically.
 *
 * Spec: docs/architecture/features/app-desktop.md → "menu.ts"
 * [COMP:app-desktop/menu-template]
 */

import { type MenuItemConstructorOptions } from "electron";

export interface MenuTemplateOptions {
  /** True on macOS — selects the app-name menu + macOS-only roles. */
  readonly isMac: boolean;
  /** Whether DevTools / reload affordances should be shown (dev only). */
  readonly isDev: boolean;
  /** The app name (the macOS app-menu label). */
  readonly appName: string;
  /**
   * The auto-update item (label + clickability from `describeUpdateState`),
   * or null to omit it entirely (auto-update disabled: unpackaged dev runs,
   * `SIDANCLAW_DISABLE_AUTO_UPDATE`). macOS: in the app menu after About
   * (the platform convention); Windows/Linux: in the File menu before Exit.
   */
  readonly update: { readonly label: string; readonly enabled: boolean } | null;
  /**
   * The active target (docs/plans/consumer-local-experience.md §2.1/§2.3):
   * renders a disabled `Target: <label>` indicator plus the switch item, and
   * hides Sign In/Out for a local target (a local brain has no login).
   * Omit/null to keep the pre-dual-target menu.
   */
  readonly target?: { readonly kind: "cloud" | "local"; readonly label: string } | null;
}

export interface MenuTemplateHandlers {
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
}

/** Build the platform-appropriate menu template (pure). */
export function buildMenuTemplate(
  opts: MenuTemplateOptions,
  handlers: MenuTemplateHandlers,
): MenuItemConstructorOptions[] {
  const { isMac, isDev, appName } = opts;

  const viewSubmenu: MenuItemConstructorOptions[] = [
    { role: "reload" },
    { type: "separator" },
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    // The zoomIn role's default accelerator is Cmd/Ctrl+Plus, which on US
    // layouts needs Shift. This hidden alias makes plain Cmd/Ctrl+= zoom in
    // too (the browser convention); a hidden item's accelerator still fires.
    {
      role: "zoomIn",
      accelerator: "CommandOrControl+=",
      visible: false,
      acceleratorWorksWhenHidden: true,
    },
    { type: "separator" },
    { role: "togglefullscreen" },
  ];
  if (isDev) {
    viewSubmenu.push({ type: "separator" }, { role: "toggleDevTools" });
  }

  // The custom actions both platforms share (the same code path as the hotkey).
  const appActions: MenuItemConstructorOptions[] = [
    {
      label: "Quick Capture",
      accelerator: "CommandOrControl+Shift+Space",
      click: () => handlers.onQuickCapture(),
    },
  ];
  // A local target has no login (the shell mints the local-owner session), so
  // Sign In/Out only render for the cloud target.
  if (opts.target?.kind !== "local") {
    appActions.push(
      { type: "separator" },
      { label: "Sign In", click: () => handlers.onSignIn() },
      { label: "Sign Out", click: () => handlers.onSignOut() },
    );
  }
  // The active-target indicator + switch (§2.1 toggle, §2.3 visible indicator).
  if (opts.target) {
    appActions.push(
      { type: "separator" },
      { label: `Target: ${opts.target.label}`, enabled: false },
      {
        label:
          opts.target.kind === "cloud" ? "Switch to Local Brain…" : "Switch to sidanclaw Cloud",
        click: () => handlers.onSwitchTarget(),
      },
    );
  }

  // The single auto-update item (state-derived label; absent when disabled).
  const updateItems: MenuItemConstructorOptions[] = opts.update
    ? [{ label: opts.update.label, enabled: opts.update.enabled, click: () => handlers.onUpdate() }]
    : [];

  const fileSubmenu: MenuItemConstructorOptions[] = [...appActions];
  if (updateItems.length > 0) fileSubmenu.push({ type: "separator" }, ...updateItems);
  fileSubmenu.push({ type: "separator" }, { role: "quit" });

  const firstMenu: MenuItemConstructorOptions = isMac
    ? {
        label: appName,
        submenu: [
          { role: "about" },
          ...updateItems,
          { type: "separator" },
          ...appActions,
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      }
    : {
        // Windows/Linux: no app menu — actions live under "File"; "quit" renders
        // as "Exit". macOS-only roles (about/hide/...) are intentionally absent.
        label: "File",
        submenu: fileSubmenu,
      };

  const windowSubmenu: MenuItemConstructorOptions[] = isMac
    ? [{ role: "minimize" }, { role: "zoom" }, { role: "front" }] // zoom/front are macOS-only
    : [{ role: "minimize" }, { role: "close" }];

  return [
    firstMenu,
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    { label: "View", submenu: viewSubmenu },
    { label: "Window", submenu: windowSubmenu },
  ];
}
