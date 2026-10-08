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

  it("contains the status row in the sidebar and floats it when the sidebar collapses", () => {
    const footer = source.match(
      /data-workspace-footer\s+className=\{cn\(\s*"([^"]+)"/,
    )?.[1];

    expect(footer).toBeDefined();
    // Pinned to the bottom-left corner at the sidebar's width, out of flow so
    // the surface runs to the bottom edge instead of sitting above a bar.
    expect(footer).toContain("absolute bottom-0 left-0");
    // `w-64` is the sidebar <aside>'s own width in both layouts (the phone
    // drawer wrapper is wider than the aside it holds).
    expect(footer).toMatch(/(?:^|\s)w-64(?:\s|$)/);
    expect(footer).not.toMatch(/\bshrink-0\b/);
    // Transparent: the sidebar's reserved slot supplies the surface and the
    // hairline, so a collapsed sidebar leaves a bare floating label.
    expect(footer).not.toMatch(/\bbg-|\bborder-/);
    // Click-through except for the label and the intake chip.
    expect(footer).toContain("pointer-events-none");
    expect(footer).toContain("[&>*]:pointer-events-auto");

    // The sidebar reserves the row, and both halves share one height.
    expect(sidebarSource).toContain("data-doc-sidebar-status-slot");
    expect(sidebarSource).toMatch(
      /data-doc-sidebar-status-slot[\s\S]{0,200}WORKSPACE_STATUS_ROW_HEIGHT_CLASS/,
    );
    expect(source).toMatch(
      /data-workspace-footer[\s\S]{0,400}WORKSPACE_STATUS_ROW_HEIGHT_CLASS/,
    );
  });

  it("hides only the healthy phone label when the drawer is closed", () => {
    const status = source.slice(source.indexOf("data-workspace-sync-status"));
    expect(status).toContain('!sidebarOpen && !hasSyncNotice && "max-md:hidden"');
    // Attention states remain visible, including paused writes without a pending count.
    expect(source).toContain(
      "offlineState.offline || offlineState.pending > 0 || offlineState.paused > 0 || offlineState.reconnecting",
    );
    // Only the label is gated: uploading and updating remain independently reachable.
    expect(status).toMatch(/<\/div>\s*<DesktopUpdateChip \/>\s*<BrainIntakeTray/);
  });

  it("uses an emerald dot for the healthy Online sync state", () => {
    expect(source).toContain(
      'hasSyncNotice ? "bg-amber-500" : "bg-emerald-500"',
    );
    expect(source).not.toContain(
      'hasSyncNotice ? "bg-amber-500" : "bg-muted-foreground/50"',
    );
  });
});
