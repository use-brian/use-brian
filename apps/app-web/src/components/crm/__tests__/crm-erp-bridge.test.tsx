// @vitest-environment jsdom

/** [COMP:app-web/crm-commercial-operations] ERP bridge UI: binding status, import review and confirm, cutover reconciliation and commit, self enrollment. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const commercial = vi.hoisted(() => ({ executeCrmCommercialCommand: vi.fn() }));
const erp = vi.hoisted(() => ({ getCrmErpBinding: vi.fn(), getCrmErpImport: vi.fn(), getCrmErpCutover: vi.fn() }));
vi.mock("@/lib/api/crm-commercial", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api/crm-commercial")>(),
  ...commercial,
}));
vi.mock("@/lib/api/crm-erp", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api/crm-erp")>(),
  ...erp,
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: vi.fn(async () => true) }));

import { confirmDialog } from "@/components/ui/confirm-dialog";
import { CrmErpBridgeSettings } from "../operations/erp-bridge-settings";
import type { CrmErpBindingStatus, CrmErpCutoverDetail, CrmErpImportDetail } from "@/lib/api/crm-erp";
import { CrmReferenceRequestError } from "@/lib/api/crm-references";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const e = en.crmPage.erpBridge;
const WORKSPACE_ID = "workspace-1";
const IMPORT_ID = "00000000-0000-4000-8000-000000000d01";
const CUTOVER_ID = "00000000-0000-4000-8000-000000000d02";
const TARGET_ID = "00000000-0000-4000-8000-000000000101";

const status = (patch: Partial<CrmErpBindingStatus> = {}, writerState: CrmErpBindingStatus["binding"]["writerState"] = "legacy"): CrmErpBindingStatus => ({
  schemaVersion: 1,
  binding: {
    id: "00000000-0000-4000-8000-000000000b01",
    bindingKey: "reference-erp",
    label: "Example ERP",
    integrationCredentialId: null,
    writerState,
    recordClasses: ["client", "engagement"],
    referenceDefinitions: null,
    version: 2,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
  },
  capabilities: { journeys: ["client_master", "protected_fees"], commands: [], reads: [], legacyWritesAllowed: writerState === "legacy" },
  mapped: [{ legacyType: "client", count: 12 }, { legacyType: "engagement", count: 30 }],
  recentCutovers: [{ id: CUTOVER_ID, state: "prepared", version: 1, createdAt: "2026-10-03T00:00:00.000Z", committedAt: null }],
  recentImports: [{ id: IMPORT_ID, state: "staged", reportHash: "hash-1", createdAt: "2026-10-03T00:00:00.000Z", confirmedAt: null }],
  viewerEnrollment: null,
  ...patch,
});

const importDetail = (patch: Partial<CrmErpImportDetail["report"]> = {}): CrmErpImportDetail => ({
  id: IMPORT_ID,
  bindingKey: "reference-erp",
  state: "staged",
  recordsHash: "records-1",
  reportHash: "hash-1",
  report: {
    counts: {
      client: { create: 2, update: 1, unchanged: 9 },
      engagement: { create: 3, update: 0, unchanged: 27 },
    },
    fees: [{ kind: "confirmed", currency: "HKD", total: "125000.00", engagements: 3 }],
    conflicts: [],
    possibleDuplicates: [{ legacyType: "client", legacyId: "C-77", existingTargetId: TARGET_ID }],
    rows: [
      { legacyType: "client", legacyId: "C-77", action: "create", targetId: null, changes: [], recode: false },
      { legacyType: "client", legacyId: "C-12", action: "update", targetId: TARGET_ID, changes: ["name"], recode: true },
      { legacyType: "engagement", legacyId: "E-01", action: "unchanged", targetId: TARGET_ID, changes: [], recode: false },
    ],
    ...patch,
  },
  outcome: null,
  version: 1,
  createdAt: "2026-10-03T00:00:00.000Z",
  confirmedAt: null,
});

const cutover = (reconciled: boolean): CrmErpCutoverDetail => ({
  id: CUTOVER_ID,
  bindingKey: "reference-erp",
  state: "prepared",
  recordClasses: ["client", "engagement"],
  source: { counts: { client: 12, engagement: reconciled ? 30 : 31 }, exportHash: "export-1" },
  reconciliation: {
    brianCounts: { client: 12, engagement: 30 },
    sourceCounts: { client: 12, engagement: reconciled ? 30 : 31 },
    countMismatches: reconciled ? [] : ["engagement"],
    exportHashMatches: reconciled,
    pendingStagedImports: reconciled ? 0 : 1,
    reconciled,
    lastImportId: IMPORT_ID,
  },
  finalSource: null,
  version: 4,
  createdAt: "2026-10-03T00:00:00.000Z",
  committedAt: null,
});

let host: HTMLDivElement;
let root: Root;

async function settle() {
  for (let index = 0; index < 10; index += 1) await act(async () => { await Promise.resolve(); });
}
async function mount(canConfigure = true) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(
    <I18nProvider locale="en" dict={en}><CrmErpBridgeSettings workspaceId={WORKSPACE_ID} canConfigure={canConfigure} /></I18nProvider>,
  ));
  await settle();
}
const button = (label: string, within: ParentNode = host) =>
  Array.from(within.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === label);
const field = (label: string) => host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
async function click(target: HTMLElement | undefined | null) {
  expect(target).toBeTruthy();
  await act(async () => target!.click());
  await settle();
}
async function type(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}
async function submit(form: HTMLFormElement | null) {
  expect(form).toBeTruthy();
  await act(async () => { form!.requestSubmit(); });
  await settle();
}
async function loadBinding(key = "reference-erp") {
  await type(field(e.bindingKey), key);
  await click(button(e.load));
}
const ok = (record: unknown) => ({ command: "x", record, created: true, duplicate: false, emittedEventIds: [] });
const sent = (index = 0) => commercial.executeCrmCommercialCommand.mock.calls[index][1];
const refuse = (reason: string, details: Record<string, unknown> = {}) =>
  new CrmReferenceRequestError("conflict", 409, { reason, ...details }, "refused");

beforeEach(() => {
  vi.clearAllMocks();
  erp.getCrmErpBinding.mockResolvedValue(status());
  erp.getCrmErpImport.mockResolvedValue(importDetail());
  erp.getCrmErpCutover.mockResolvedValue(cutover(true));
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

describe("[COMP:app-web/crm-commercial-operations] ERP bridge UI", () => {
  it("waits for a binding key and shows a clear not-configured state on 404", async () => {
    erp.getCrmErpBinding.mockResolvedValue(null);
    await mount();
    expect(host.textContent).toContain(e.enterKey);
    expect(erp.getCrmErpBinding).not.toHaveBeenCalled();
    await loadBinding("missing-erp");
    expect(erp.getCrmErpBinding).toHaveBeenCalledWith(WORKSPACE_ID, "missing-erp");
    expect(host.querySelector("[data-erp-not-configured]")?.textContent).toBe(e.notConfigured.replace("{key}", "missing-erp"));
  });

  it("renders the writer state, record classes, linked counts and capabilities", async () => {
    erp.getCrmErpBinding.mockResolvedValue(status({}, "frozen"));
    await mount();
    await loadBinding();
    const card = host.querySelector("[data-erp-status]")!;
    expect(card.querySelector("[data-erp-writer-state]")?.getAttribute("data-erp-writer-state")).toBe("frozen");
    expect(card.textContent).toContain(e.writerStates.frozen);
    expect(card.textContent).toContain(e.writerStateHelp.frozen);
    expect(card.textContent).toContain("Clients, Engagements");
    expect(card.querySelector("[data-erp-mapped]")?.textContent).toBe("Clients: 12, Engagements: 30");
    expect(card.querySelector("[data-erp-journeys]")?.textContent).toContain(e.journeyLabels.protected_fees);
  });

  it("renders the import report and confirms with the reviewed report hash", async () => {
    commercial.executeCrmCommercialCommand.mockResolvedValue(ok({ importId: IMPORT_ID }));
    await mount();
    await loadBinding();
    await click(button(e.review, host.querySelector(`[data-erp-import="${IMPORT_ID}"]`)!));
    const detail = host.querySelector("[data-erp-import-detail]")!;
    const clientCounts = detail.querySelector('[data-erp-count-row="client"]')!;
    expect(clientCounts.querySelector('[data-erp-count="create"]')?.textContent).toBe("2");
    expect(clientCounts.querySelector('[data-erp-count="unchanged"]')?.textContent).toBe("9");
    expect(detail.querySelector("[data-erp-fees]")?.textContent).toContain("Confirmed HKD 125000.00 across 3 engagements");
    expect(detail.querySelector("[data-erp-duplicates]")?.textContent).toContain(e.duplicatesHelp);
    expect(detail.querySelector('[data-erp-row="C-12"]')?.textContent).toContain(e.recode);
    expect(detail.querySelector('[data-erp-row="E-01"]')).toBeNull();
    await click(button(e.confirmImport));
    expect(vi.mocked(confirmDialog).mock.calls[0][0].description).toContain("5 new and 1 updated records, 36 unchanged");
    expect(sent()).toEqual({
      kind: "confirm_erp_import",
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      importId: IMPORT_ID,
      expectedReportHash: "hash-1",
    });
    expect(host.textContent).toContain(e.importConfirmed);
  });

  it("explains a stale import refusal and rereads the binding", async () => {
    commercial.executeCrmCommercialCommand.mockRejectedValue(refuse("stale_import"));
    await mount();
    await loadBinding();
    await click(button(e.review));
    await click(button(e.confirmImport));
    expect(host.textContent).toContain(e.refusals.stale_import);
    expect(erp.getCrmErpBinding).toHaveBeenCalledTimes(2);
  });

  it("blocks confirm while the report carries conflicts", async () => {
    erp.getCrmErpImport.mockResolvedValue(importDetail({
      conflicts: [{ legacyType: "engagement", legacyId: "E-09", reason: "client_missing", detail: "C-404" }],
    }));
    await mount();
    await loadBinding();
    await click(button(e.review));
    expect(host.querySelector("[data-erp-conflicts]")?.textContent).toContain(e.conflictReasons.client_missing);
    expect(host.textContent).toContain(e.importBlockedConflicts);
    expect(button(e.confirmImport)?.disabled).toBe(true);
  });

  it("disables commit with the unreconciled reasons when the cutover does not reconcile", async () => {
    erp.getCrmErpCutover.mockResolvedValue(cutover(false));
    await mount();
    await loadBinding();
    await click(button(e.review, host.querySelector(`[data-erp-cutover="${CUTOVER_ID}"]`)!));
    const detail = host.querySelector("[data-erp-cutover-detail]")!;
    expect(detail.querySelector('[data-erp-reconcile-row="engagement"]')?.getAttribute("data-mismatch")).toBe("true");
    expect(detail.querySelector("[data-erp-reconciled]")?.getAttribute("data-erp-reconciled")).toBe("false");
    const reasons = detail.querySelector("[data-erp-unreconciled]")!.textContent;
    expect(reasons).toContain(e.unreconciledCounts.replace("{classes}", "Engagements"));
    expect(reasons).toContain(e.unreconciledHash);
    expect(reasons).toContain(e.unreconciledPending.replace("{count}", "1"));
    expect(button(e.commitCutover)?.disabled).toBe(true);
    expect(host.textContent).toContain(e.commitBlocked);
  });

  it("commits a reconciled cutover with the run's recorded source as the final source", async () => {
    commercial.executeCrmCommercialCommand.mockResolvedValue(ok({ cutoverId: CUTOVER_ID }));
    await mount();
    await loadBinding();
    await click(button(e.review, host.querySelector(`[data-erp-cutover="${CUTOVER_ID}"]`)!));
    await click(button(e.commitCutover));
    expect(vi.mocked(confirmDialog).mock.calls[0][0].description).toBe(e.commitCutoverDescription.replace("{classes}", "Clients, Engagements"));
    expect(sent()).toEqual({
      kind: "commit_erp_cutover",
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      cutoverId: CUTOVER_ID,
      expectedVersion: 4,
      finalSource: { counts: { client: 12, engagement: 30 }, exportHash: "export-1" },
    });
    expect(host.textContent).toContain(e.cutoverCommitted);
  });

  it("explains a stale cutover refusal and rereads the run", async () => {
    commercial.executeCrmCommercialCommand.mockRejectedValue(refuse("stale_cutover", { reconciliation: {} }));
    await mount();
    await loadBinding();
    await click(button(e.review, host.querySelector(`[data-erp-cutover="${CUTOVER_ID}"]`)!));
    await click(button(e.commitCutover));
    expect(host.textContent).toContain(e.refusals.stale_cutover);
    expect(erp.getCrmErpCutover).toHaveBeenCalledTimes(2);
  });

  it("shows members the same state with no confirm or commit", async () => {
    await mount(false);
    await loadBinding();
    expect(host.textContent).toContain(e.readOnly);
    await click(button(e.review, host.querySelector(`[data-erp-import="${IMPORT_ID}"]`)!));
    expect(host.querySelector("[data-erp-import-detail]")).toBeTruthy();
    expect(button(e.confirmImport)).toBeUndefined();
    await click(host.querySelector<HTMLButtonElement>(`[aria-label="${e.close}"]`));
    await click(button(e.review, host.querySelector(`[data-erp-cutover="${CUTOVER_ID}"]`)!));
    expect(host.querySelector("[data-erp-reconciliation]")).toBeTruthy();
    expect(button(e.commitCutover)).toBeUndefined();
    expect(button(e.enroll)).toBeTruthy();
  });

  it("enrolls the signed-in member's own ERP user and explains viewer_taken", async () => {
    commercial.executeCrmCommercialCommand.mockRejectedValueOnce(refuse("viewer_taken"));
    await mount(false);
    await loadBinding();
    expect(host.querySelector("[data-erp-identity]")?.textContent).toContain(e.identityHelp);
    await type(field(e.legacyUserId), " U-42 ");
    await submit(host.querySelector<HTMLFormElement>("[data-erp-identity] form"));
    expect(vi.mocked(confirmDialog).mock.calls[0][0].title).toBe(e.enrollTitle.replace("{id}", "U-42"));
    expect(sent()).toEqual({
      kind: "enroll_erp_viewer",
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      bindingKey: "reference-erp",
      legacyUserId: "U-42",
    });
    expect(host.textContent).toContain(e.refusals.viewer_taken);
  });

  it("shows an existing enrollment instead of the form", async () => {
    erp.getCrmErpBinding.mockResolvedValue(status({ viewerEnrollment: { legacyUserId: "U-7" } }));
    await mount(false);
    await loadBinding();
    expect(host.querySelector("[data-erp-enrolled]")?.textContent).toContain(e.identityLinked.replace("{id}", "U-7"));
    expect(button(e.enroll)).toBeUndefined();
  });

  it("keeps the review readable at 360px: tables scroll in place and entry text stays 16px on phones", async () => {
    await mount();
    await loadBinding();
    await click(button(e.review));
    const tables = Array.from(host.querySelectorAll("table"));
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) expect(table.parentElement?.className).toContain("overflow-x-auto");
    for (const input of Array.from(host.querySelectorAll("input"))) expect(input.className).toContain("text-[16px]");
    expect(host.innerHTML).not.toMatch(/\b(min-)?w-\[\d+px\]/);
  });

  it("reuses the operation id when an uncertain confirm is retried", async () => {
    commercial.executeCrmCommercialCommand
      .mockRejectedValueOnce(new CrmReferenceRequestError("network_error", null))
      .mockResolvedValueOnce(ok({ importId: IMPORT_ID }));
    await mount();
    await loadBinding();
    await click(button(e.review));
    await click(button(e.confirmImport));
    expect(host.textContent).toContain(en.crmPage.commercial.uncertainWrite);
    expect(button(e.confirmImport)?.disabled).toBe(true);
    await click(button(en.crmPage.commercial.retryWrite));
    expect(sent(1)).toEqual(sent(0));
    expect(sent(1).operationId).toBe(sent(0).operationId);
    expect(host.textContent).toContain(e.importConfirmed);
  });
});
