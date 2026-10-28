/**
 * [COMP:app-web/doc-shell] Mobile workspace navigation trigger styling.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../workspace-chrome.tsx", import.meta.url),
  "utf8",
);
const sidebarSource = readFileSync(
  new URL("../doc-sidebar.tsx", import.meta.url),
  "utf8",
);
const statusSource = readFileSync(
  new URL("../../chrome/workspace-status.tsx", import.meta.url),
  "utf8",
);

describe("[COMP:app-web/doc-shell] mobile workspace menu", () => {
  it("uses the compact top-bar button treatment without a floating card", () => {
    const triggerClass = source.match(
      /data-doc-mobile-menu[\s\S]*?className="([^"]+)"/,
    )?.[1];

    expect(triggerClass).toBeDefined();
    // 44px target inside the h-11 topbar row (responsive contract M3).
    expect(triggerClass).toContain("fixed left-1 top-0");
    expect(triggerClass).toContain("size-11");
    expect(triggerClass).toContain("hover:bg-muted");
    expect(triggerClass).toContain("focus-visible:ring-2");
    expect(triggerClass).not.toMatch(
      /\b(?:h-9|w-9|bg-background\/80|shadow|ring-1|backdrop-blur)\b/,
    );
  });

  it("mounts one icon-based workspace menu outside the collapsible panel", () => {
    expect(sidebarSource.match(/<WorkspaceSwitcher\b/g)).toHaveLength(1);
    expect(sidebarSource).toContain("<WorkspaceSwitcher iconOnly />");
    expect(sidebarSource.indexOf("<WorkspaceSwitcher")).toBeLessThan(sidebarSource.indexOf("data-doc-context-sidebar"));
    expect(sidebarSource).not.toContain("railAvatar");
  });

  it("keeps theme and status on the desktop rail when the contextual panel collapses", () => {
    const footer = source.match(
      /data-workspace-footer\s+className=\{cn\(\s*"([^"]+)"/,
    )?.[1];

    expect(footer).toBeDefined();
    expect(footer).toContain("absolute bottom-0 left-0");
    expect(footer).toContain("md:w-14");
    expect(footer).toContain("md:z-40");
    expect(footer).toContain("pointer-events-none");
    expect(footer).not.toMatch(/\bbg-|\bborder-/);
    // One persistent picker/live region. Collapsing does not conditionally
    // mount either control or change its desktop anchor.
    expect(source.match(/<WorkspaceThemePicker \/>/g)).toHaveLength(1);
    expect(source.match(/<WorkspaceStatus\b/g)).toHaveLength(1);
    expect(statusSource.match(/data-workspace-sync-status/g)).toHaveLength(1);
    expect(sidebarSource).not.toContain("<PalettePicker");
    expect(sidebarSource).toContain("data-doc-sidebar-footer-slot");
    const railSource = readFileSync(new URL("../workspace-app-rail.tsx", import.meta.url), "utf8");
    expect(railSource).toContain("data-workspace-rail-footer-slot");
    expect(source).toContain("WORKSPACE_STATUS_ROW_HEIGHT_CLASS");
  });

  it("keeps updates in the shared status control and retains phone notices", () => {
    expect(statusSource).toContain('!sidebarOpen && !hasSyncNotice && !status && "max-md:hidden"');
    // Attention states remain visible, including paused writes without a pending count.
    expect(statusSource).toContain(
      "offlineState.offline || offlineState.pending > 0 || offlineState.paused > 0 || offlineState.reconnecting",
    );
    // Update text never renders as a separate chip over the contextual panel.
    expect(source).not.toContain("DesktopUpdateChip");
    expect(source).toMatch(/data-workspace-activity-footer[\s\S]*?<BrainIntakeTray/);
    expect(source).toContain('!sidebarOpen && "max-md:hidden"');
  });

});
