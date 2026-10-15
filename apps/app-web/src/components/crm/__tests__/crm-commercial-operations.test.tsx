// @vitest-environment jsdom

/** [COMP:app-web/crm-commercial-operations] Business references settings and record panel. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  executeCrmReferenceCommand: vi.fn(),
  findCrmReferences: vi.fn(),
  getCrmReferenceHistory: vi.fn(),
  listCrmReferenceDefinitions: vi.fn(),
  listCrmReferencesForTarget: vi.fn(),
  previewCrmReference: vi.fn(),
}));
vi.mock("@/lib/api/crm-references", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api/crm-references")>(),
  ...api,
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: vi.fn(async () => true) }));

import { CrmReferenceSettings } from "../operations/references-settings";
import { CrmRecordReferences } from "../operations/record-references";
import {
  CrmReferenceRequestError,
  type CrmBusinessReference,
  type CrmReferenceDefinition,
} from "@/lib/api/crm-references";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = en.crmPage.references;
const WORKSPACE_ID = "workspace-1";
const COMPANY_ID = "00000000-0000-4000-8000-000000000101";

const customerCode: CrmReferenceDefinition = {
  id: "00000000-0000-4000-8000-000000000201",
  definitionKey: "customer_code",
  label: "Customer code",
  targetKinds: ["company"],
  assignmentMode: "native",
  namespaceKey: "customer_code",
  format: [{ kind: "literal", text: "C-" }, { kind: "counter", width: 5 }],
  partitionDimensions: [],
  categories: [],
  timezone: "UTC",
  assignmentEvent: "explicit",
  changePolicy: "correctable",
  counterStart: 1,
  status: "active",
  version: 3,
  seriesId: "00000000-0000-4000-8000-000000000301",
  counterWidth: 5,
  partitions: [{ partitionKey: "all", nextValue: 43, allocatedCount: 42 }],
};

const ledgerCode: CrmReferenceDefinition = {
  ...customerCode,
  id: "00000000-0000-4000-8000-000000000202",
  definitionKey: "ledger_code",
  label: "Ledger code",
  namespaceKey: "ledger_code",
  assignmentMode: "manual",
  format: null,
  seriesId: null,
  counterWidth: null,
  partitions: [],
};

const reference = (patch: Partial<CrmBusinessReference>): CrmBusinessReference => ({
  id: "00000000-0000-4000-8000-000000000401",
  definitionId: customerCode.id,
  definitionKey: customerCode.definitionKey,
  definitionVersion: 3,
  targetKind: "company",
  targetId: COMPANY_ID,
  targetName: "Example Trading Ltd",
  value: "C-00042",
  origin: "native",
  status: "active",
  businessDate: null,
  categoryKey: null,
  counterValue: 42,
  partitionKey: "all",
  parentSnapshot: null,
  version: 1,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...patch,
});

let host: HTMLDivElement;
let root: Root;

async function settle() {
  for (let index = 0; index < 10; index += 1) await act(async () => { await Promise.resolve(); });
}
async function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<I18nProvider locale="en" dict={en}>{node}</I18nProvider>));
  await settle();
}
const buttons = () => Array.from(host.querySelectorAll<HTMLButtonElement>("button"));
const button = (label: string) => buttons().find((item) => item.textContent?.trim() === label);
async function click(target: HTMLElement | undefined) {
  expect(target).toBeTruthy();
  await act(async () => target!.click());
  await settle();
}
async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listCrmReferenceDefinitions.mockResolvedValue([customerCode]);
  api.listCrmReferencesForTarget.mockResolvedValue([]);
  api.previewCrmReference.mockResolvedValue({
    reserves: false,
    explanation: { segments: [], maskedExample: "C-#####", needsBusinessDate: false, needsCategory: false },
    needsBusinessDate: false,
    needsCategory: false,
    categories: [],
    partitionKey: "all",
    assignmentMode: "native",
    assignmentEvent: "explicit",
  });
  api.getCrmReferenceHistory.mockResolvedValue({ reference: reference({}), history: [] });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.querySelectorAll("[data-base-ui-portal]").forEach((node) => node.remove());
});

describe("[COMP:app-web/crm-commercial-operations] references UI", () => {
  it("lists definitions read-only for members, with mutation controls and counters only for admins", async () => {
    await mount(<CrmReferenceSettings workspaceId={WORKSPACE_ID} canConfigure={false} />);
    expect(host.textContent).toContain("Customer code");
    expect(host.textContent).toContain(t.assignmentModeLabels.native);
    expect(host.textContent).toContain(t.assignmentEventLabels.explicit);
    expect(host.textContent).toContain(t.noPartitions);
    expect(host.textContent).toContain(t.readOnly);
    expect(button(t.edit)).toBeUndefined();
    expect(button(t.newDefinition)).toBeUndefined();
    expect(button(t.importTitle)).toBeUndefined();
    act(() => root.unmount());
    host.remove();

    await mount(<CrmReferenceSettings workspaceId={WORKSPACE_ID} canConfigure />);
    expect(button(t.edit)).toBeTruthy();
    expect(button(t.newDefinition)).toBeTruthy();
    expect(host.querySelector("[data-reference-counters]")?.textContent).toContain("all: next 43, 42 assigned");
  });

  it("renders a local masked example from the bounded format builder", async () => {
    await mount(<CrmReferenceSettings workspaceId={WORKSPACE_ID} canConfigure />);
    await click(button(t.newDefinition));
    const example = () => host.querySelector("[data-reference-definition-editor] [data-reference-masked-example]")?.textContent;
    expect(example()).toBe("C-#####");
    await click(button(t.segmentKinds.date));
    expect(example()).toBe("C-#####YYYY");
    const moveUp = Array.from(host.querySelectorAll<HTMLButtonElement>(`button[aria-label="${t.moveUp}"]`)).at(-1);
    await click(moveUp);
    expect(example()).toBe("C-YYYY#####");
    await click(button(t.segmentKinds.counter));
    expect(host.textContent).toContain(t.nativeNeedsCounter);
  });

  it("proposes invoice numbering with a saved client code and one three-digit annual sequence", async () => {
    api.executeCrmReferenceCommand.mockResolvedValue({ command: "save_reference_definition", record: {}, created: true, duplicate: false, emittedEventIds: [] });
    await mount(<CrmReferenceSettings workspaceId={WORKSPACE_ID} canConfigure />);
    await click(button(t.newDefinition));
    await click(button(t.invoicePreset));
    const editor = host.querySelector("[data-reference-definition-editor]")!;
    expect(editor.querySelector("[data-reference-masked-example]")?.textContent).toBe("INV-[customer_code]-YYYY-###");
    expect(editor.textContent).toContain(t.invoicePresetHelp);
    expect(api.executeCrmReferenceCommand).not.toHaveBeenCalled();
    await click(button(t.save));
    expect(api.executeCrmReferenceCommand.mock.calls[0][1]).toMatchObject({ kind: "save_reference_definition", definition: {
      targetKinds: ["invoice"], assignmentEvent: "issue", assignmentMode: "native", counterStart: 1,
      partitionDimensions: ["business_year"], changePolicy: "immutable",
      format: [{ kind: "literal", text: "INV-" }, { kind: "parent", definitionKey: "customer_code" },
        { kind: "literal", text: "-" }, { kind: "date", part: "yyyy" }, { kind: "literal", text: "-" }, { kind: "counter", width: 3 }],
    } });
  });

  it("requires a company-code definition before saving the invoice preset", async () => {
    api.listCrmReferenceDefinitions.mockResolvedValue([]);
    await mount(<CrmReferenceSettings workspaceId={WORKSPACE_ID} canConfigure />);
    await click(button(t.newDefinition));
    await click(button(t.invoicePreset));
    expect(button(t.save)?.disabled).toBe(true);
    expect(host.querySelector("[data-reference-draft-issues]")?.textContent).toContain(t.pickParent);
    await click(button(t.clientCodePreset));
    expect(button(t.save)?.disabled).toBe(false);
    expect(host.querySelector("[data-reference-masked-example]")).toBeNull();
    api.executeCrmReferenceCommand.mockResolvedValue({ command: "save_reference_definition", record: {}, created: true, duplicate: false, emittedEventIds: [] });
    await click(button(t.save));
    expect(api.executeCrmReferenceCommand.mock.calls[0][1]).toMatchObject({ definition: {
      definitionKey: "client_code", targetKinds: ["company"], assignmentMode: "manual", format: null, assignmentEvent: "explicit",
    } });
  });

  it("shows which fields are frozen when an edited definition is refused", async () => {
    api.executeCrmReferenceCommand.mockRejectedValue(new CrmReferenceRequestError("conflict", 409,
      { reason: "definition_frozen", fields: ["namespaceKey", "counter"] }));
    await mount(<CrmReferenceSettings workspaceId={WORKSPACE_ID} canConfigure />);
    await click(button(t.edit));
    await click(button(t.save));
    const command = api.executeCrmReferenceCommand.mock.calls[0][1];
    expect(command).toMatchObject({ kind: "save_reference_definition", definitionId: customerCode.id, expectedVersion: 3 });
    const frozen = host.querySelector("[data-reference-frozen]")?.textContent ?? "";
    expect(frozen).toContain(t.frozenTitle);
    expect(frozen).toContain(t.frozenFields.namespaceKey);
    expect(frozen).toContain(t.frozenFields.counter);
    // A definite refusal ends the intent: the next save is a new operation.
    await click(button(t.save));
    expect(api.executeCrmReferenceCommand.mock.calls[1][1].operationId).not.toBe(command.operationId);
  });

  it("previews without reserving, then assigns with one operation id reused on retry after a network failure", async () => {
    api.executeCrmReferenceCommand
      .mockRejectedValueOnce(new CrmReferenceRequestError("network_error", null))
      .mockResolvedValueOnce({ command: "assign_business_reference", record: { reference: { value: "C-00042" } }, created: true, duplicate: false, emittedEventIds: [] });
    await mount(<CrmRecordReferences workspaceId={WORKSPACE_ID} recordKind="company" recordId={COMPANY_ID} canConfigure={false} />);
    expect(host.textContent).toContain(t.panelEmpty);
    await click(button(t.assign.replace("{label}", "Customer code")));
    expect(api.previewCrmReference).toHaveBeenCalledWith(WORKSPACE_ID, { definitionKey: "customer_code", targetId: COMPANY_ID });
    expect(host.querySelector("[data-reference-masked-example]")?.textContent).toBe("C-#####");
    expect(host.textContent).toContain(t.notReserved);
    expect(api.executeCrmReferenceCommand).not.toHaveBeenCalled();

    await click(button(t.confirmAssign));
    expect(host.textContent).toContain(t.uncertainWrite);
    const first = api.executeCrmReferenceCommand.mock.calls[0][1];
    expect(first).toMatchObject({ kind: "assign_business_reference", definitionKey: "customer_code", target: { kind: "company", id: COMPANY_ID } });
    expect(first.value).toBeUndefined();

    api.listCrmReferencesForTarget.mockResolvedValue([reference({})]);
    await click(button(t.retryWrite));
    expect(api.executeCrmReferenceCommand).toHaveBeenCalledTimes(2);
    expect(api.executeCrmReferenceCommand.mock.calls[1][1]).toEqual(first);
    expect(host.textContent).toContain("Assigned C-00042.");
    expect(host.textContent).not.toContain(t.uncertainWrite);
    expect(host.querySelector('[data-reference-status="active"]')?.textContent).toContain("C-00042");
  });

  it("reports a duplicate assignment as already assigned, not new", async () => {
    api.executeCrmReferenceCommand.mockResolvedValue({ command: "assign_business_reference", record: { reference: { value: "C-00042" } }, created: false, duplicate: true, emittedEventIds: [] });
    await mount(<CrmRecordReferences workspaceId={WORKSPACE_ID} recordKind="company" recordId={COMPANY_ID} canConfigure={false} />);
    await click(button(t.assign.replace("{label}", "Customer code")));
    await click(button(t.confirmAssign));
    expect(host.textContent).toContain(t.alreadyAssigned.replace("{value}", "C-00042"));
    expect(host.textContent).not.toContain("Assigned C-00042.");
  });

  it("renders a reference collision as a definite refusal without offering a blind retry", async () => {
    api.listCrmReferenceDefinitions.mockResolvedValue([ledgerCode]);
    api.previewCrmReference.mockResolvedValue({
      reserves: false, explanation: null, needsBusinessDate: false, needsCategory: false,
      categories: [], partitionKey: null, assignmentMode: "manual", assignmentEvent: "explicit",
    });
    api.executeCrmReferenceCommand.mockRejectedValue(new CrmReferenceRequestError("conflict", 409, { reason: "reference_collision" }));
    await mount(<CrmRecordReferences workspaceId={WORKSPACE_ID} recordKind="company" recordId={COMPANY_ID} canConfigure={false} />);
    await click(button(t.assign.replace("{label}", "Ledger code")));
    const input = host.querySelector<HTMLInputElement>("[data-reference-assign-form] input")!;
    await type(input, "LEDGER-7");
    await click(button(t.confirmAssign));
    expect(api.executeCrmReferenceCommand.mock.calls[0][1]).toMatchObject({ kind: "assign_business_reference", value: "LEDGER-7" });
    expect(host.textContent).toContain(t.refusals.reference_collision);
    expect(host.textContent).not.toContain(t.uncertainWrite);
    expect(button(t.retryWrite)).toBeUndefined();
  });

  it("shows former values muted and gates Replace and Retire on authority", async () => {
    api.listCrmReferencesForTarget.mockResolvedValue([
      reference({}),
      reference({ id: "00000000-0000-4000-8000-000000000402", value: "C-00007", status: "replaced" }),
    ]);
    await mount(<CrmRecordReferences workspaceId={WORKSPACE_ID} recordKind="company" recordId={COMPANY_ID} canConfigure={false} />);
    const former = host.querySelector<HTMLElement>('[data-reference-status="replaced"]')!;
    expect(former.className).toContain("text-muted-foreground");
    expect(former.textContent).toContain("C-00007");
    expect(former.textContent).toContain(t.referenceStatus.replaced);
    expect(button(t.replace)).toBeUndefined();
    expect(button(t.retire)).toBeUndefined();
    act(() => root.unmount());
    host.remove();

    await mount(<CrmRecordReferences workspaceId={WORKSPACE_ID} recordKind="company" recordId={COMPANY_ID} canConfigure />);
    expect(buttons().filter((item) => item.textContent?.trim() === t.replace)).toHaveLength(1);
    expect(buttons().filter((item) => item.textContent?.trim() === t.retire)).toHaveLength(1);
  });

  it("renders a failed read with a Retry that re-reads instead of writing", async () => {
    api.listCrmReferencesForTarget.mockRejectedValueOnce(new CrmReferenceRequestError("network_error", null));
    await mount(<CrmRecordReferences workspaceId={WORKSPACE_ID} recordKind="company" recordId={COMPANY_ID} canConfigure={false} />);
    expect(host.textContent).toContain(t.panelFailed);
    await click(button(t.retry));
    expect(api.listCrmReferencesForTarget).toHaveBeenCalledTimes(2);
    expect(api.executeCrmReferenceCommand).not.toHaveBeenCalled();
    expect(host.textContent).toContain(t.panelEmpty);
  });

  it("finds references by code, mutes former values, opens the record and states an empty result", async () => {
    api.findCrmReferences.mockResolvedValueOnce({
      references: [
        reference({}),
        reference({ id: "00000000-0000-4000-8000-000000000402", value: "C-00041", status: "retired" }),
      ],
      nextCursor: null,
    });
    const onOpenRecord = vi.fn();
    await mount(<CrmReferenceSettings workspaceId={WORKSPACE_ID} canConfigure={false} onOpenRecord={onOpenRecord} />);
    const input = host.querySelector<HTMLInputElement>(`[data-reference-lookup] input[aria-label="${t.findLabel}"]`)!;
    expect(input.className).toContain("text-[16px]");
    await type(input, "C-0004");
    await click(button(t.matchLabels.prefix));
    await click(button(t.find));
    expect(api.findCrmReferences).toHaveBeenCalledWith(WORKSPACE_ID, "C-0004", "prefix");
    const results = host.querySelector("[data-reference-lookup-results]")!;
    expect(results.textContent).toContain("Customer code");
    const retired = results.querySelector<HTMLElement>('[data-reference-status="retired"]')!;
    expect(retired.className).toContain("text-muted-foreground");
    expect(retired.textContent).toContain(t.referenceStatus.retired);
    await click(results.querySelector<HTMLButtonElement>(`button[aria-label="${t.openRecord.replace("{name}", "Example Trading Ltd")}"]`)!);
    expect(onOpenRecord).toHaveBeenCalledWith("company", COMPANY_ID);

    api.findCrmReferences.mockResolvedValueOnce({ references: [], nextCursor: null });
    await type(input, "INV-9");
    await click(button(t.find));
    expect(host.textContent).toContain(t.findEmpty.replace("{query}", "INV-9"));

    api.findCrmReferences.mockRejectedValueOnce(new CrmReferenceRequestError("network_error", null));
    await click(button(t.find));
    expect(host.textContent).toContain(t.findFailed);
  });

  it("renders import conflicts and states that nothing was imported", async () => {
    api.executeCrmReferenceCommand.mockRejectedValue(new CrmReferenceRequestError("conflict", 409, {
      reason: "import_conflicts",
      conflictCount: 3,
      conflicts: [
        { index: 0, reason: "value_reserved", value: "C-00001" },
        { index: -1, reason: "counter_would_decrease", partitionKey: "all" },
      ],
    }));
    await mount(<CrmReferenceSettings workspaceId={WORKSPACE_ID} canConfigure />);
    await click(button(t.importTitle));
    const textarea = host.querySelector<HTMLTextAreaElement>("[data-reference-import] textarea")!;
    await type(textarea, `company,${COMPANY_ID},C-00001,active\ncompany,not-a-uuid,C-00002`);
    expect(host.textContent).toContain("Line 2: record ID must be a UUID");
    expect(button(t.importSubmit)?.disabled).toBe(true);
    await type(textarea, `company,${COMPANY_ID},C-00001,active`);
    expect(host.querySelector("[data-reference-import] table")?.textContent).toContain("C-00001");
    await click(button(t.importSubmit));
    expect(api.executeCrmReferenceCommand.mock.calls[0][1]).toMatchObject({
      kind: "import_business_references",
      definitionKey: "customer_code",
      rows: [{ target: { kind: "company", id: COMPANY_ID }, value: "C-00001", status: "active" }],
      partitionCounters: [],
    });
    const conflicts = host.querySelector("[data-reference-import-conflicts]")?.textContent ?? "";
    expect(conflicts).toContain(t.importConflictsTitle);
    expect(conflicts).toContain("3 conflicts need review");
    expect(conflicts).toContain(`Row 1 (C-00001): ${t.importConflictReasons.value_reserved}`);
    expect(conflicts).toContain(`Counter all: ${t.importConflictReasons.counter_would_decrease}`);
    expect(conflicts).toContain("Showing the first 2 of 3.");
  });
});
