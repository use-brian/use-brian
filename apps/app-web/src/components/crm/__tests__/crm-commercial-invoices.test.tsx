// @vitest-environment jsdom

/** [COMP:app-web/crm-commercial-operations] Invoice preparation: prepare, revise, ready, issue, retry, void. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  executeCrmCommercialCommand: vi.fn(),
  getCrmPreparation: vi.fn(),
  listCrmCommercialProfiles: vi.fn(),
  listCrmCustomerAccounts: vi.fn(),
  listCrmInvoices: vi.fn(),
  listCrmOperationDefinitions: vi.fn(),
  listCrmSellers: vi.fn(),
  resolveCrmCommercialFields: vi.fn(),
}));
vi.mock("@/lib/api/crm-commercial", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api/crm-commercial")>(),
  ...api,
}));
vi.mock("@/lib/office/api", () => ({ readOfficeReleasedFile: vi.fn() }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: vi.fn(async () => true) }));

import { confirmDialog } from "@/components/ui/confirm-dialog";
import { CrmRecordAccounts } from "../operations/record-accounts";
import { InvoicePreparationPanel } from "../operations/invoice-preparation";
import type {
  CrmCustomerAccount,
  CrmInvoiceDetail,
  CrmOperationDefinition,
  CrmOperationVersion,
  CrmPreparationDetail,
  CrmResolutionQuestion,
  CrmSellerProfile,
} from "@/lib/api/crm-commercial";
import { CrmReferenceRequestError } from "@/lib/api/crm-references";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = en.crmPage.invoices;
const WORKSPACE_ID = "workspace-1";
const COMPANY_ID = "00000000-0000-4000-8000-000000000101";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000501";
const DEAL_ID = "00000000-0000-4000-8000-000000000a01";
const PREPARATION_ID = "00000000-0000-4000-8000-000000000b01";
const INVOICE_ID = "00000000-0000-4000-8000-000000000c01";
const ARTIFACT_ID = "00000000-0000-4000-8000-000000000d01";
const deals = [{ id: DEAL_ID, name: "Website rebuild" }];

const seller: CrmSellerProfile = {
  id: "00000000-0000-4000-8000-000000000601",
  sellerKey: "example_studio",
  legalName: "Example Studio Ltd",
  displayName: "Example Studio",
  companyId: null,
  timezone: "UTC",
  status: "active",
  sensitivity: "internal",
  version: 2,
};

const account: CrmCustomerAccount = {
  id: ACCOUNT_ID,
  sellerId: seller.id,
  sellerKey: seller.sellerKey,
  companyId: COMPANY_ID,
  companyName: "Example Trading Ltd",
  label: "Retainer account",
  billingContactId: null,
  billingAddress: null,
  status: "active",
  sensitivity: "internal",
  version: 1,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const operationVersion: CrmOperationVersion = {
  id: "00000000-0000-4000-8000-000000000801",
  versionNumber: 1,
  state: "accepted",
  instructions: "Bill from the account defaults.",
  instructionSource: null,
  fieldBindings: [
    { fieldKey: "currency", label: "Currency", type: "currency", requiredFor: "draft", overridable: false, protected: false, sources: ["account"] },
    { fieldKey: "po_number", label: "PO number", type: "string", requiredFor: "issue", overridable: true, protected: false, sources: ["transaction"] },
  ],
  templateBinding: null,
  reviewPolicy: "exact_version_review",
  referenceDefinitionKey: "invoice_number",
  configHash: "hash-1",
  proposedByKind: "user",
  acceptedByKind: "user",
  acceptedAt: "2026-10-01T00:00:00.000Z",
  createdAt: "2026-10-01T00:00:00.000Z",
};

const operation: CrmOperationDefinition = {
  id: "00000000-0000-4000-8000-000000000901",
  operationKey: "invoice",
  operationKind: "invoice",
  label: "Invoice",
  currentVersionId: operationVersion.id,
  status: "active",
  version: 2,
  versions: [operationVersion],
};

const content = {
  dealIds: [DEAL_ID],
  servicePeriodStart: "2026-09-01",
  servicePeriodEnd: "2026-09-30",
  lines: [{ description: "Design work", quantity: "2", unitPrice: "750.25", dealId: DEAL_ID }],
  values: { po_number: { type: "string" as const, value: "PO-7" } },
  allocations: [],
};

const totals = {
  currency: "HKD",
  minorUnits: 2,
  lines: [{ ...content.lines[0], amount: "1500.50" }],
  subtotal: "1500.50",
  taxRate: "0.1",
  taxAmount: "150.05",
  total: "1650.55",
};

const invoiceDetail = (patch: Partial<CrmInvoiceDetail>): CrmInvoiceDetail => ({
  id: INVOICE_ID,
  state: "draft",
  number: null,
  issueDate: null,
  currency: "HKD",
  minorUnits: 2,
  total: "1650.55",
  subtotal: "1500.50",
  taxRate: "0.1",
  taxAmount: "150.05",
  preparationId: PREPARATION_ID,
  accountId: ACCOUNT_ID,
  version: 4,
  issuedAt: null,
  xlsxFileId: null,
  pdfFileId: null,
  pdfPageCount: null,
  voidedAt: null,
  voidReason: null,
  lines: [{ description: "Design work", quantity: "2", unitPrice: "750.25", amount: "1500.50", dealId: DEAL_ID }],
  allocations: [{ dealId: DEAL_ID, amount: "1650.55" }],
  attempts: [],
  ...patch,
});

function detail(patch: {
  state?: CrmPreparationDetail["preparation"]["state"];
  version?: number;
  issueReady?: boolean;
  draftRenderError?: string | null;
  officeArtifactId?: string | null;
  questions?: CrmResolutionQuestion[];
  invoice?: Partial<CrmInvoiceDetail>;
} = {}): CrmPreparationDetail {
  const state = patch.state ?? "draft";
  const version = patch.version ?? 3;
  return {
    preparation: {
      id: PREPARATION_ID,
      title: "September invoice",
      state,
      version,
      readyVersion: state === "draft" ? null : version,
      operationVersionId: operationVersion.id,
      accountId: ACCOUNT_ID,
      officeArtifactId: patch.officeArtifactId === undefined ? ARTIFACT_ID : patch.officeArtifactId,
      officeVersion: 2,
      officeBinding: { version },
      draftRenderError: patch.draftRenderError ?? null,
    },
    current: {
      version,
      content,
      resolution: {
        fields: {
          currency: { fieldKey: "currency", type: "currency", value: "HKD", source: { kind: "account", recordId: "p1", version: 2, effectiveFrom: null }, overridden: false },
          po_number: { fieldKey: "po_number", type: "string", value: "PO-7", source: { kind: "transaction", recordId: null, version: null, effectiveFrom: null }, overridden: true },
        },
      },
      totals: { invoice: totals, allocations: [{ dealId: DEAL_ID, amount: "1650.55" }] },
      questions: patch.questions ?? [],
      draftReady: true,
      issueReady: patch.issueReady ?? true,
    },
    invoice: invoiceDetail({ state, ...patch.invoice }),
  };
}

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
const field = <T extends HTMLElement = HTMLInputElement>(label: string) => host.querySelector<T>(`[aria-label="${label}"]`)!;
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
const panel = (canIssue: boolean) => (
  <InvoicePreparationPanel workspaceId={WORKSPACE_ID} preparationId={PREPARATION_ID} canIssue={canIssue}
    deals={deals} operations={[operation]} onChanged={() => {}} />
);
const ok = (record: unknown) => ({ command: "x", record, created: false, duplicate: false, emittedEventIds: [] });

beforeEach(() => {
  vi.clearAllMocks();
  api.listCrmSellers.mockResolvedValue([seller]);
  api.listCrmCustomerAccounts.mockResolvedValue([account]);
  api.listCrmCommercialProfiles.mockResolvedValue([]);
  api.listCrmOperationDefinitions.mockResolvedValue([operation]);
  api.listCrmInvoices.mockResolvedValue([]);
  api.getCrmPreparation.mockResolvedValue(detail());
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root?.unmount());
  host?.remove();
  document.querySelectorAll("[data-base-ui-portal]").forEach((node) => node.remove());
});

describe("[COMP:app-web/crm-commercial-operations] invoice preparation UI", () => {
  it("prepares an invoice with the complete content and an operation id, then shows its open questions", async () => {
    api.getCrmPreparation.mockResolvedValue(detail({
      issueReady: false,
      officeArtifactId: null,
      questions: [{ fieldKey: "due_date", label: "Due date", kind: "missing", requiredFor: "issue", question: "When is payment due?" }],
    }));
    api.executeCrmCommercialCommand.mockResolvedValue(ok({ preparation: { id: PREPARATION_ID }, version: { version: 1 } }));
    await mount(<CrmRecordAccounts workspaceId={WORKSPACE_ID} companyId={COMPANY_ID} canConfigure={false} deals={deals} />);
    await click(button(t.toggle));
    expect(api.listCrmInvoices).toHaveBeenCalledWith(WORKSPACE_ID, { accountId: ACCOUNT_ID });
    expect(host.textContent).toContain(t.empty);
    await click(button(t.prepare));
    await type(field(t.lineDescription), "Design work");
    await type(field(t.lineQuantity), "2");
    await type(field(t.lineUnitPrice), "750.25");
    await type(field(t.servicePeriodStart), "2026-09-01");
    await type(field("PO number"), "PO-7");
    await click(button(t.submitPrepare));

    const command = api.executeCrmCommercialCommand.mock.calls[0][1];
    expect(command).toEqual({
      kind: "prepare_commercial_document",
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      operationKey: "invoice",
      accountId: ACCOUNT_ID,
      dealIds: [DEAL_ID],
      servicePeriodStart: "2026-09-01",
      servicePeriodEnd: null,
      lines: [{ description: "Design work", quantity: "2", unitPrice: "750.25", dealId: null }],
      values: { po_number: { type: "string", value: "PO-7" } },
      allocations: [],
    });
    expect(api.getCrmPreparation).toHaveBeenCalledWith(WORKSPACE_ID, PREPARATION_ID);
    const questions = host.querySelector("[data-invoice-questions]")!.textContent!;
    expect(questions).toContain("Due date");
    expect(questions).toContain("When is payment due?");
    expect(host.textContent).toContain(t.markReadyHint);
  });

  it("reuses the operation id when an uncertain prepare is retried", async () => {
    api.executeCrmCommercialCommand
      .mockRejectedValueOnce(new CrmReferenceRequestError("network_error", null))
      .mockResolvedValueOnce(ok({ preparation: { id: PREPARATION_ID }, version: { version: 1 } }));
    await mount(<CrmRecordAccounts workspaceId={WORKSPACE_ID} companyId={COMPANY_ID} canConfigure={false} deals={deals} />);
    await click(button(t.toggle));
    await click(button(t.prepare));
    await type(field(t.lineDescription), "Design work");
    await type(field(t.lineUnitPrice), "100");
    await click(button(t.submitPrepare));
    await click(button(en.crmPage.commercial.retryWrite));
    expect(api.executeCrmCommercialCommand.mock.calls[1][1]).toEqual(api.executeCrmCommercialCommand.mock.calls[0][1]);
  });

  it("revises with the complete content and the version the user read", async () => {
    api.executeCrmCommercialCommand.mockResolvedValue(ok({ preparation: { id: PREPARATION_ID }, version: { version: 4 } }));
    await mount(panel(false));
    await click(button(t.revise));
    await type(field(t.lineQuantity), "3");
    await click(button(t.submitRevise));
    expect(api.executeCrmCommercialCommand.mock.calls[0][1]).toEqual({
      kind: "revise_commercial_preparation",
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      preparationId: PREPARATION_ID,
      expectedVersion: 3,
      dealIds: [DEAL_ID],
      servicePeriodStart: "2026-09-01",
      servicePeriodEnd: "2026-09-30",
      lines: [{ description: "Design work", quantity: "3", unitPrice: "750.25", dealId: DEAL_ID }],
      values: { po_number: { type: "string", value: "PO-7" } },
      allocations: [],
    });
    expect(host.textContent).toContain(t.prepared.replace("{version}", "4"));
  });

  it("shows server totals, resolved sources and the Office draft link without recomputing money", async () => {
    await mount(panel(false));
    expect(host.querySelector("[data-invoice-total]")?.textContent).toBe("HKD 1,650.55");
    expect(host.querySelector("[data-invoice-totals]")?.textContent).toContain(t.tax.replace("{rate}", "10"));
    expect(host.querySelector('[data-resolved-field="currency"] [data-resolved-source]')?.textContent).toBe("Account v2");
    expect(host.querySelector<HTMLAnchorElement>("[data-invoice-office-link]")?.getAttribute("href")).toBe(`/w/${WORKSPACE_ID}/office/${ARTIFACT_ID}`);
    expect(host.textContent).toContain(t.draftMarkers);
    expect(host.querySelector("[data-invoice-number]")?.textContent).toBe(t.numberAtIssue);
  });

  it("gates mark ready and issue by state and role", async () => {
    await mount(panel(true));
    expect(button(t.markReady)?.disabled).toBe(false);
    expect(button(t.issueAction)).toBeUndefined();
    act(() => root.unmount());
    host.remove();

    api.getCrmPreparation.mockResolvedValue(detail({ issueReady: false }));
    await mount(panel(true));
    expect(button(t.markReady)?.disabled).toBe(true);
    act(() => root.unmount());
    host.remove();

    api.getCrmPreparation.mockResolvedValue(detail({ state: "ready" }));
    await mount(panel(true));
    expect(button(t.markReady)).toBeUndefined();
    expect(button(t.issueAction)).toBeTruthy();
    act(() => root.unmount());
    host.remove();

    await mount(panel(false));
    expect(button(t.issueAction)).toBeUndefined();
    expect(host.textContent).toContain(t.issuedOnly);
  });

  it("marks ready against the current version", async () => {
    api.executeCrmCommercialCommand.mockResolvedValue(ok({}));
    await mount(panel(false));
    await click(button(t.markReady));
    expect(api.executeCrmCommercialCommand.mock.calls[0][1]).toMatchObject({
      kind: "mark_preparation_ready", preparationId: PREPARATION_ID, expectedVersion: 3,
    });
    expect(host.textContent).toContain(t.markedReady.replace("{version}", "3"));
  });

  it("explains a self-review refusal truthfully", async () => {
    api.executeCrmCommercialCommand.mockRejectedValue(new CrmReferenceRequestError("not_authorized", 403, { reason: "self_review" }));
    await mount(panel(true));
    await click(button(t.markReady));
    expect(host.textContent).toContain(t.refusals.self_review);
  });

  it("confirms issue with the number-at-issue and not-sent copy, then sends the issue date", async () => {
    api.getCrmPreparation.mockResolvedValue(detail({ state: "ready" }));
    api.executeCrmCommercialCommand.mockResolvedValue(ok({}));
    await mount(panel(true));
    await type(field(t.issueDate), "2026-10-12");
    await click(button(t.issueAction));
    const options = vi.mocked(confirmDialog).mock.calls[0][0];
    expect(options.description).toBe(t.issueConfirmDescription.replace("{total}", "HKD 1,650.55").replace("{date}", "2026-10-12"));
    expect(options.description).toContain("assigned at issue");
    expect(options.description).toContain("does not send");
    expect(api.executeCrmCommercialCommand.mock.calls[0][1]).toMatchObject({
      kind: "issue_invoice", preparationId: PREPARATION_ID, expectedVersion: 3, issueDate: "2026-10-12",
    });
  });

  it("does not issue when the confirmation is declined", async () => {
    api.getCrmPreparation.mockResolvedValue(detail({ state: "ready" }));
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    await mount(panel(true));
    await click(button(t.issueAction));
    expect(api.executeCrmCommercialCommand).not.toHaveBeenCalled();
  });

  it.each([
    ["stale_sources", t.refusals.stale_sources],
    ["not_ready", t.refusals.not_ready],
    ["numbering_unconfigured", t.refusals.numbering_unconfigured],
  ])("renders the %s refusal truthfully", async (reason, text) => {
    api.getCrmPreparation.mockResolvedValue(detail({ state: "ready" }));
    api.executeCrmCommercialCommand.mockRejectedValue(new CrmReferenceRequestError("conflict", 409, { reason }));
    await mount(panel(true));
    await click(button(t.issueAction));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(text);
    expect(button(en.crmPage.commercial.retryWrite)).toBeUndefined();
  });

  it("re-reads before retrying a failed issue and sends the fresh invoice version", async () => {
    const failed = { state: "issue_failed" as const, invoice: {
      number: "INV-0042", issueDate: "2026-10-12", version: 5,
      attempts: [{ attempt: 1, state: "failed" as const, errorCode: "release_blocked", errorDetail: "Workbook release was refused", createdAt: "2026-10-12T01:00:00.000Z" }],
    } };
    api.getCrmPreparation
      .mockResolvedValueOnce(detail(failed))
      .mockResolvedValueOnce(detail({ ...failed, invoice: { ...failed.invoice, version: 6 } }))
      .mockResolvedValue(detail({ state: "issue_pending", invoice: { number: "INV-0042", version: 7 } }));
    api.executeCrmCommercialCommand.mockResolvedValue(ok({}));
    await mount(panel(true));
    expect(host.querySelector('[data-invoice-attempt="1"]')?.textContent).toContain("release_blocked: Workbook release was refused");
    expect(host.querySelector("[data-invoice-number]")?.textContent).toBe("INV-0042");
    await click(button(t.retryIssue));
    expect(api.getCrmPreparation).toHaveBeenCalledTimes(3);
    expect(api.getCrmPreparation.mock.invocationCallOrder[1]).toBeLessThan(api.executeCrmCommercialCommand.mock.invocationCallOrder[0]);
    expect(api.executeCrmCommercialCommand.mock.calls[0][1]).toMatchObject({ kind: "retry_invoice_issue", invoiceId: INVOICE_ID, expectedVersion: 6 });
    expect(host.textContent).toContain(t.retryStarted);
  });

  it("does not retry when the re-read shows the invoice already moved on", async () => {
    api.getCrmPreparation
      .mockResolvedValueOnce(detail({ state: "issue_failed", invoice: { number: "INV-0042" } }))
      .mockResolvedValue(detail({ state: "issued", invoice: { number: "INV-0042" } }));
    await mount(panel(true));
    await click(button(t.retryIssue));
    expect(api.executeCrmCommercialCommand).not.toHaveBeenCalled();
    expect(host.textContent).toContain(t.retryChanged);
  });

  it("shows the draft render error", async () => {
    api.getCrmPreparation.mockResolvedValue(detail({ draftRenderError: "Office rendering is unavailable on this deployment.", officeArtifactId: null }));
    await mount(panel(false));
    const error = host.querySelector("[data-invoice-draft-error]")!;
    expect(error.textContent).toContain(t.draftRenderFailed);
    expect(error.textContent).toContain("Office rendering is unavailable on this deployment.");
  });

  it("says issued is not sent or paid, and voids with a reason after confirmation", async () => {
    api.getCrmPreparation.mockResolvedValue(detail({ state: "issued", invoice: {
      number: "INV-0042", issueDate: "2026-10-12", version: 8, xlsxFileId: "file-xlsx", pdfFileId: "file-pdf",
    } }));
    api.executeCrmCommercialCommand.mockResolvedValue(ok({}));
    await mount(panel(true));
    expect(host.querySelector("[data-invoice-state-note]")?.textContent).toBe(t.stateNotes.issued);
    expect(button(t.downloadPdf)).toBeTruthy();
    expect(button(t.void)?.disabled).toBe(true);
    await type(field<HTMLTextAreaElement>(t.voidReason), "Billed the wrong entity");
    await click(button(t.void));
    expect(vi.mocked(confirmDialog).mock.calls[0][0]).toMatchObject({ variant: "destructive", title: t.voidConfirmTitle.replace("{number}", "INV-0042") });
    expect(api.executeCrmCommercialCommand.mock.calls[0][1]).toMatchObject({
      kind: "void_invoice", invoiceId: INVOICE_ID, expectedVersion: 8, reason: "Billed the wrong entity",
    });
  });

  it("shows members no issue, retry or void controls", async () => {
    api.getCrmPreparation.mockResolvedValue(detail({ state: "issue_failed", invoice: { number: "INV-0042" } }));
    await mount(panel(false));
    expect(button(t.retryIssue)).toBeUndefined();
    expect(button(t.void)).toBeUndefined();
    expect(host.querySelector("[data-invoice-void]")).toBeNull();
    act(() => root.unmount());
    host.remove();

    api.getCrmPreparation.mockResolvedValue(detail({ state: "issued", invoice: { number: "INV-0042" } }));
    await mount(panel(false));
    expect(button(t.void)).toBeUndefined();
    expect(button(t.issueAction)).toBeUndefined();
  });

  it("re-reads a pending issue with backoff", async () => {
    vi.useFakeTimers();
    api.getCrmPreparation.mockResolvedValue(detail({ state: "issue_pending", invoice: { number: "INV-0042" } }));
    await mount(panel(true));
    expect(api.getCrmPreparation).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1500); });
    await settle();
    expect(api.getCrmPreparation).toHaveBeenCalledTimes(2);
  });
});
