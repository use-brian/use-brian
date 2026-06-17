/**
 * [COMP:app-web/breadcrumb] Breadcrumb — depth-aware top-bar location trail.
 *
 * app-web vitest has no jsdom, so we assert over server-rendered markup
 * (`renderToStaticMarkup`) — the same SSR-only pattern floating-toolbar.test.tsx
 * uses. The contract under test is the **current-crumb rename affordance**:
 * when `onRenameCurrent` is wired the trailing (current-page) crumb renders as
 * a button (the popover trigger) carrying the rename hint; without it, the
 * current crumb is a plain non-interactive label. This is what lets the title
 * in the chrome double as the rename trigger (so the ⋯ menu drops its
 * redundant "Rename" item). The inline edit field itself lives in a base-ui
 * Popover that only mounts when open client-side, so SSR sees just the trigger
 * — its open/commit/escape behavior is exercised by hand / e2e, not here.
 */

import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { WorkspaceContextProvider } from "@/lib/workspace-context";
import type { Crumb } from "@/lib/sidebar-tree";
import { Breadcrumb } from "../breadcrumb";

const dict = en as unknown as Dictionary;
const RENAME_HINT = en.docPage.breadcrumbRenameHint;

function crumb(id: string, name: string): Crumb {
  return { id, name, icon: null, entity: "tasks", viewType: "table", nameOrigin: "user" };
}

/** Render the breadcrumb inside the providers it reads (i18n + workspace). */
function html(node: ReactElement): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" dict={dict}>
      <WorkspaceContextProvider
        value={{ workspaceId: "ws1", name: "Acme", role: "owner", clearance: "internal", me: { id: "u1" } }}
      >
        {node}
      </WorkspaceContextProvider>
    </I18nProvider>,
  );
}

describe("[COMP:app-web/breadcrumb] Breadcrumb current-crumb rename", () => {
  it("renders nothing for an empty chain", () => {
    expect(html(<Breadcrumb crumbs={[]} onNavigate={() => {}} />)).toBe("");
  });

  it("root-level page: current crumb is a rename button when wired", () => {
    const markup = html(
      <Breadcrumb
        crumbs={[crumb("p1", "Quarterly plan")]}
        onNavigate={() => {}}
        onRenameCurrent={() => {}}
      />,
    );
    expect(markup).toContain("<button");
    expect(markup).toContain(`title="${RENAME_HINT}"`);
    expect(markup).toContain("Quarterly plan");
  });

  it("root-level page: current crumb is a plain label without the handler", () => {
    const markup = html(
      <Breadcrumb crumbs={[crumb("p1", "Quarterly plan")]} onNavigate={() => {}} />,
    );
    // No rename handler → no interactive control at all on a root page.
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain(`title="${RENAME_HINT}"`);
    expect(markup).toContain("Quarterly plan");
  });

  it("falls back to the localized Untitled label for a blank name", () => {
    const markup = html(
      <Breadcrumb
        crumbs={[crumb("p1", "   ")]}
        onNavigate={() => {}}
        onRenameCurrent={() => {}}
      />,
    );
    expect(markup).toContain(en.docPage.breadcrumbUntitled);
  });

  it("nested page: only the trailing crumb carries the rename hint", () => {
    const markup = html(
      <Breadcrumb
        crumbs={[crumb("root", "Workspace docs"), crumb("leaf", "Sub page")]}
        onNavigate={() => {}}
        onRenameCurrent={() => {}}
      />,
    );
    // Exactly one rename target — the current page, not the ancestor.
    const hits = markup.split(`title="${RENAME_HINT}"`).length - 1;
    expect(hits).toBe(1);
    expect(markup).toContain("Sub page");
  });
});
