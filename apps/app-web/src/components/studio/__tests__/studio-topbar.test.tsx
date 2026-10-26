// @vitest-environment jsdom
/**
 * [COMP:app-web/studio-topbar] Route-owned action slot.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  STUDIO_TOPBAR_ACTIONS_ID,
  StudioTopbarActions,
  StudioTopbar,
} from "../studio-topbar";
import { WorkspaceTopbarProvider, WorkspaceTopbarHost, WorkspaceAppTitleHost } from "@/components/chrome/workspace-topbar";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

vi.mock("next/navigation", () => ({ useRouter: () => ({ back: vi.fn(), forward: vi.fn() }), usePathname: () => "/w/workspace-a/studio/connectors" }));
vi.mock("@/components/doc/doc-sidebar-data", () => ({ useSidebarData: () => ({ sidebarCollapsed: false }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let pageRoot: HTMLDivElement;
let root: Root;

beforeEach(() => {
  const target = document.createElement("div");
  target.id = STUDIO_TOPBAR_ACTIONS_ID;
  document.body.appendChild(target);

  pageRoot = document.createElement("div");
  document.body.appendChild(pageRoot);
  root = createRoot(pageRoot);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("[COMP:app-web/studio-topbar] StudioTopbarActions", () => {
  it("resolves route actions on a cold mount after the shell creates the toolbar portal", async () => {
    document.getElementById(STUDIO_TOPBAR_ACTIONS_ID)?.remove();
    await act(async () => root.render(
      <I18nProvider locale="en" dict={en}>
        <WorkspaceTopbarProvider>
          <WorkspaceAppTitleHost />
          <WorkspaceTopbarHost />
          <main>
            <StudioTopbar workspaceId="workspace-a" />
            <StudioTopbarActions><button>Add connector</button></StudioTopbarActions>
          </main>
        </WorkspaceTopbarProvider>
      </I18nProvider>,
    ));
    const header = pageRoot.querySelector("[data-workspace-topbar-host]")!;
    expect(header.querySelector(`#${STUDIO_TOPBAR_ACTIONS_ID}`)?.textContent).toBe("Add connector");
    expect(pageRoot.querySelector("main")?.textContent).toBe("");
    expect(pageRoot.querySelector("[data-workspace-app-heading] a")?.getAttribute("href")).toBe("/w/workspace-a/studio/connectors");
  });

  it("portals a route-owned action into the persistent top bar and removes it on unmount", async () => {
    await act(async () => {
      root.render(
        <StudioTopbarActions>
          <button type="button">Add connector</button>
        </StudioTopbarActions>,
      );
    });

    const target = document.getElementById(STUDIO_TOPBAR_ACTIONS_ID);
    expect(target?.textContent).toBe("Add connector");
    expect(pageRoot.textContent).toBe("");

    await act(async () => root.render(null));
    expect(target?.textContent).toBe("");
  });
});
