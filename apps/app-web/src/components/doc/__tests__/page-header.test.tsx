/**
 * [COMP:app-web/page-header] Page header — the Notion **navbar** (Row 2).
 *
 * Node-only vitest (no jsdom / @testing-library): we mount through
 * `renderToString` (an SSR pass that runs the initial render) and assert
 * against the static markup, the same approach as
 * mobile-chat-drawer.test.tsx / floating-toolbar.test.tsx. We assert the
 * location breadcrumb (current page name), the Share action, the favorite
 * star (its label tracks saved/draft), and the ⋯ overflow trigger. The ⋯-menu
 * *contents* (Duplicate / Full width / Delete) render in a base-ui portal only
 * once opened, so they're out of scope for an SSR snapshot — that click wiring
 * is a directly-bound contract verified by the type-check.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { ViewMetadata } from "@/lib/api/views";
import type { Crumb } from "@/lib/sidebar-tree";
import { WorkspaceContextProvider } from "@/lib/workspace-context";
import { PageHeader } from "../page-header";

const dict = en as unknown as Dictionary;

function makeView(over: Partial<ViewMetadata> = {}): ViewMetadata {
  return {
    id: "view-1",
    workspaceId: "ws-1",
    name: "My Page",
    state: "draft",
    description: null,
    entity: "tasks",
    viewType: "table",
    icon: null,
    fullWidth: false,
    ...over,
  } as ViewMetadata;
}

const crumbs: Crumb[] = [
  { id: "view-1", name: "My Page", icon: null, entity: "tasks", viewType: "table", nameOrigin: "user" },
];

function renderHeader(over: Partial<ViewMetadata> = {}): string {
  const view = makeView(over);
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <WorkspaceContextProvider
        value={{ workspaceId: "ws-1", name: "Acme", role: "owner", clearance: "confidential", me: { id: "u1" } }}
      >
        <PageHeader
          view={view}
          breadcrumb={crumbs}
          provider={null}
          status="connected"
          synced
          onNavigate={() => {}}
          onMutated={() => {}}
          onDeleted={() => {}}
          onRenameValue={() => {}}
          onDuplicate={() => {}}
          fullWidth={view.fullWidth}
          onToggleFullWidth={() => {}}
          memberClearance="confidential"
          onChangeClearance={() => {}}
          currentUser={{ id: "u1", name: "Tester" }}
        />
      </WorkspaceContextProvider>
    </I18nProvider>,
  );
}

describe("[COMP:app-web/page-header] Page header (Notion navbar)", () => {
  it("renders the location breadcrumb with the current page name", () => {
    expect(renderHeader()).toContain("My Page");
  });

  it("renders the Share action", () => {
    expect(renderHeader()).toContain(dict.docPage.headerShare);
  });

  it("labels the favorite star 'Add to Favorites' for a draft", () => {
    expect(renderHeader({ state: "draft" })).toContain(
      dict.docPage.headerFavoriteAdd,
    );
  });

  it("labels the favorite star 'Remove from Favorites' for a saved page", () => {
    expect(renderHeader({ state: "saved" })).toContain(
      dict.docPage.headerFavoriteRemove,
    );
  });

  it("renders the ⋯ overflow-menu trigger", () => {
    expect(renderHeader()).toContain(dict.docPage.headerMoreAria);
  });
});
