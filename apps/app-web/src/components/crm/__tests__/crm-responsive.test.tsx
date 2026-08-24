// @vitest-environment jsdom

/** [COMP:app-web/crm-responsive] Narrow CRM navigation and detail presentation. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { CrmConfig, CrmData } from "@/lib/api/crm";

const crmApi = vi.hoisted(() => ({ listCrmSavedViews: vi.fn(async () => []) }));
vi.mock("@/lib/api/crm", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api/crm")>(),
  listCrmSavedViews: crmApi.listCrmSavedViews,
}));

import { CrmMobileActions } from "../crm-mobile-actions";
import { ResizablePeek } from "@/components/operator/resizable-peek";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const config: CrmConfig = {
  pipelines: [
    { id: "sales", name: "Sales", isDefault: true, position: 0, stages: [] },
    { id: "renewals", name: "Renewals", isDefault: false, position: 1, stages: [] },
  ],
  fields: [],
};
const data: CrmData = { deals: [], contacts: [], companies: [] };

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<I18nProvider locale="en" dict={en}>{node}</I18nProvider>);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.querySelectorAll('[data-slot="dropdown-menu-content"]').forEach((node) => node.remove());
  root = null;
  container = null;
});

describe("[COMP:app-web/crm-responsive] responsive CRM workspace", () => {
  it("consolidates displaced controls into one labeled narrow-screen action menu", async () => {
    await mount(
      <CrmMobileActions
        workspaceId="workspace-1"
        role="admin"
        section="deals"
        data={data}
        config={config}
        currentSearch="q=example"
        onApplySearch={vi.fn()}
        onChanged={vi.fn()}
        onCreated={vi.fn()}
        onPipeline={vi.fn()}
        onReports={vi.fn()}
        onConfig={vi.fn()}
      />,
    );

    const triggers = container!.querySelectorAll<HTMLElement>("[data-crm-mobile-actions]");
    expect(triggers).toHaveLength(1);
    expect(triggers[0].getAttribute("aria-label")).toBe(en.crmPage.r2.crmActions);
    expect(triggers[0].className).toContain("sm:hidden");

    await act(async () => {
      triggers[0].click();
      await Promise.resolve();
    });

    const popup = document.body.querySelector<HTMLElement>('[data-slot="dropdown-menu-content"]');
    expect(popup).toBeTruthy();
    expect(popup!.className).toContain("sm:hidden");
    expect(popup!.textContent).toContain(en.crmPage.r2.newRecord);
    expect(popup!.textContent).toContain(en.crmPage.r2.importCsv);
    expect(popup!.textContent).toContain(en.crmPage.r2.exportCsv);
    expect(popup!.textContent).toContain(en.crmPage.r2.reviewDuplicates);
    expect(popup!.textContent).toContain(en.crmPage.r2.archivedRecords);
    expect(popup!.textContent).toContain(en.crmPage.r2.saveCurrentView);
    expect(popup!.textContent).toContain(`${en.crmPage.r2.pipeline}: Renewals`);
    expect(popup!.textContent).toContain(en.crmPage.r2.reportsTitle);
    expect(popup!.textContent).toContain(en.crmPage.r2.configTitle);

    const create = [...popup!.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]')]
      .find((item) => item.textContent?.trim() === en.crmPage.r2.newRecord);
    await act(async () => {
      create!.click();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(en.crmPage.r2.newRecordDescription);
  });

  it("turns a responsive detail peek into a full-width destination without resize chrome", async () => {
    await mount(
      <ResizablePeek responsiveFullWidth storageKey="test:crm-peek" ariaLabel="Example record">
        Detail
      </ResizablePeek>,
    );

    const panel = container!.querySelector<HTMLElement>('aside[aria-label="Example record"]');
    const resizeHandle = container!.querySelector<HTMLElement>('[role="separator"]');
    expect(panel?.className).toContain("max-lg:!w-full");
    expect(resizeHandle?.parentElement?.className).toContain("max-lg:hidden");
  });
});
