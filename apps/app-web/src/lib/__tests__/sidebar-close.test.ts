// @vitest-environment jsdom
/**
 * [COMP:app-web/sidebar-drawer-close] Drawer hygiene (responsive contract M7).
 *
 * The 2026-09-08 invite trace cost a phone user 7 taps against 4 on desktop,
 * and one of the extra three was the drawer: Settings / Invite opened the
 * modal and left the drawer open behind it, so the user paid a backdrop tap
 * after Close. Two signals now close it - a URL change (page / panel rows,
 * nav icons) and the `doc:sidebar-close` event (modal launchers). The event
 * seam is exercised here; the wiring of both signals into the chrome and the
 * launchers is pinned at the source level, because `WorkspaceChrome` and
 * `WorkspaceSwitcher` are too deep to mount in a unit test and a listener
 * that quietly disappears is exactly the regression to catch.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SIDEBAR_CLOSE_EVENT, requestSidebarClose } from "@/lib/sidebar-close";

const src = (rel: string) => readFileSync(resolve(process.cwd(), "src", rel), "utf8");

describe("[COMP:app-web/sidebar-drawer-close] request seam", () => {
  it("dispatches one window event a listener can subscribe to", () => {
    const seen = vi.fn();
    window.addEventListener(SIDEBAR_CLOSE_EVENT, seen);
    requestSidebarClose();
    expect(seen).toHaveBeenCalledTimes(1);
    window.removeEventListener(SIDEBAR_CLOSE_EVENT, seen);
  });
});

describe("[COMP:app-web/sidebar-drawer-close] wiring", () => {
  const chrome = src("components/doc/workspace-chrome.tsx");
  const switcher = src("components/workspace-switcher.tsx");
  const sidebar = src("components/doc/doc-sidebar.tsx");

  it("the chrome is the one listener and closes on every URL change", () => {
    expect(chrome).toMatch(/window\.addEventListener\(SIDEBAR_CLOSE_EVENT, onClose\)/);
    // A navigation from a page row, a panel row or a nav icon moves the URL;
    // that is the close signal for every navigating launcher at once.
    expect(chrome).toMatch(
      /useEffect\(\(\) => \{\s*setSidebarOpen\(false\);\s*\}, \[pathname, searchKey, setSidebarOpen\]\)/,
    );
    // Dialogs launched from the drawer close it too.
    expect(chrome).toMatch(/setCreateTeamspaceOpen\(true\);\s*setSidebarOpen\(false\);/);
    expect(chrome).toMatch(/setTeamspaceModal\(\{ id, tab \}\);\s*setSidebarOpen\(false\);/);
  });

  it("Settings / Invite from the switcher, and the OPEN_SETTINGS event, request a close", () => {
    // Both entry points into the modal: the popover buttons and the window event.
    expect(switcher.match(/requestSidebarClose\(\);/g)?.length).toBeGreaterThanOrEqual(2);
    expect(switcher).toMatch(/function openSettings\(section: SettingsSection\) \{[\s\S]{0,300}requestSidebarClose\(\);/);
  });

  it("the drawer head carries a first-class Invite row on phones that closes the drawer", () => {
    // Plan §6 decision 1: hamburger, Invite, form = 3 taps, parity with desktop.
    expect(sidebar).toContain("data-sidebar-invite");
    expect(sidebar).toMatch(/openWorkspaceSettings\("ws-members"\);\s*requestSidebarClose\(\);/);
    expect(sidebar).toMatch(/data-sidebar-invite[\s\S]{0,300}md:hidden/);
    expect(sidebar).toMatch(/data-sidebar-invite[\s\S]{0,300}size-11/);
  });

  it("the phone hamburger is a 44px target inside the topbar row", () => {
    expect(chrome).toMatch(/data-doc-mobile-menu[\s\S]{0,600}fixed left-1 top-0 z-20 inline-flex size-11/);
  });
});
