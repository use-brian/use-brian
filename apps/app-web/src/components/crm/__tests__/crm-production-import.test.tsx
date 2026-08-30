// @vitest-environment jsdom

/** [COMP:crm/production-import] Server preflight, confirmation, and resumable UI. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  dryRunCrmImport: vi.fn(),
  confirmCrmImport: vi.fn(),
  resumeCrmImport: vi.fn(),
  cancelCrmImport: vi.fn(),
  downloadCrmImportErrors: vi.fn(),
  storeFiles: vi.fn(),
  confirmDialog: vi.fn(),
}));
vi.mock("@/lib/api/crm", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api/crm")>(),
  dryRunCrmImport: api.dryRunCrmImport,
  confirmCrmImport: api.confirmCrmImport,
  resumeCrmImport: api.resumeCrmImport,
  cancelCrmImport: api.cancelCrmImport,
  downloadCrmImportErrors: api.downloadCrmImportErrors,
}));
vi.mock("@/lib/api/ingest", () => ({ storeFiles: api.storeFiles }));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: api.confirmDialog }));

import { CrmProductionImportPanel } from "../operations/import-panel";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
async function settle() { for (let index = 0; index < 12; index += 1) await act(async () => { await Promise.resolve(); }); }

beforeEach(() => {
  vi.clearAllMocks();
  api.storeFiles.mockResolvedValue([{ ok: true, fileId: "33333333-3333-4333-8333-333333333333" }]);
  api.dryRunCrmImport.mockResolvedValue({
    dryRunHash: "a".repeat(64), bytes: 128, totalRows: 1, validRows: 1,
    failedRows: 0, headers: ["Name"], sampleErrors: [],
  });
  api.confirmDialog.mockResolvedValue(true);
  api.confirmCrmImport.mockResolvedValue({
    id: "44444444-4444-4444-8444-444444444444", status: "ready",
    entityKind: "contact", totalRows: 1, processedRows: 0, succeededRows: 0, failedRows: 0,
  });
  api.resumeCrmImport.mockResolvedValue({
    id: "44444444-4444-4444-8444-444444444444", status: "completed",
    entityKind: "contact", totalRows: 1, processedRows: 1, succeededRows: 1, failedRows: 0,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("[COMP:crm/production-import] CRM import panel", () => {
  it("stages bytes, confirms the server dry run, and resumes to completion", async () => {
    const onImported = vi.fn();
    await act(async () => root.render(
      <I18nProvider locale="en" dict={en}>
        <CrmProductionImportPanel
          workspaceId="11111111-1111-4111-8111-111111111111"
          file={new File(["Name\nAda Example\n"], "contacts.csv", { type: "text/csv" })}
          kind="contact"
          mapping={{ 0: "name" }}
          ready
          onImported={onImported}
        />
      </I18nProvider>,
    ));
    const start = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === en.crmPage.r2.importAction);
    await act(async () => start?.click());
    await settle();

    expect(api.storeFiles).toHaveBeenCalledTimes(1);
    expect(api.dryRunCrmImport).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      entityKind: "contact", mapping: { columns: { 0: "name" } },
    }));
    expect(api.confirmDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: en.crmPage.r2.importConfirmTitle,
    }));
    expect(api.resumeCrmImport).toHaveBeenCalledTimes(1);
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Created 1; 0 failed.");
  });
});
