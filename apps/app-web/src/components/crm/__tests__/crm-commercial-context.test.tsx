// @vitest-environment jsdom

/** [COMP:app-web/crm-commercial-operations] Commercial context: sellers, accounts, accepted terms, operations, resolution preview. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  executeCrmCommercialCommand: vi.fn(),
  listCrmCommercialProfiles: vi.fn(),
  listCrmCustomerAccounts: vi.fn(),
  listCrmOperationDefinitions: vi.fn(),
  listCrmSellers: vi.fn(),
  resolveCrmCommercialFields: vi.fn(),
}));
const referenceApi = vi.hoisted(() => ({ listCrmReferenceDefinitions: vi.fn() }));
vi.mock("@/lib/api/crm-commercial", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api/crm-commercial")>(),
  ...api,
}));
vi.mock("@/lib/api/crm-references", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api/crm-references")>(),
  ...referenceApi,
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: vi.fn(async () => true) }));

import { confirmDialog } from "@/components/ui/confirm-dialog";
import { CrmCommercialSettings } from "../operations/commercial-settings";
import { CrmRecordAccounts } from "../operations/record-accounts";
import type {
  CrmCommercialProfile,
  CrmCustomerAccount,
  CrmOperationDefinition,
  CrmOperationVersion,
  CrmSellerProfile,
} from "@/lib/api/crm-commercial";
import { CrmReferenceRequestError } from "@/lib/api/crm-references";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = en.crmPage.commercial;
const WORKSPACE_ID = "workspace-1";
const COMPANY_ID = "00000000-0000-4000-8000-000000000101";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000501";

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
  billingAddress: "1 Example Road",
  status: "active",
  sensitivity: "confidential",
  version: 1,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const accountDefaults: CrmCommercialProfile = {
  id: "00000000-0000-4000-8000-000000000701",
  ownerKind: "account",
  accountId: ACCOUNT_ID,
  agreementKey: null,
  dealIds: [],
  version: 3,
  status: "accepted",
  fields: { payment_terms: { type: "string", value: "Net 30" } },
  effectiveFrom: null,
  effectiveTo: null,
  evidence: { kind: "manual" },
  sensitivity: "confidential",
};

const version = (patch: Partial<CrmOperationVersion>): CrmOperationVersion => ({
  id: "00000000-0000-4000-8000-000000000801",
  versionNumber: 1,
  state: "accepted",
  instructions: "Use the account defaults.",
  instructionSource: null,
  fieldBindings: [
    { fieldKey: "currency", label: "Currency", type: "currency", requiredFor: "draft", overridable: false, protected: false, sources: ["agreement", "account", "seller"] },
  ],
  templateBinding: null,
  reviewPolicy: "direct",
  referenceDefinitionKey: null,
  configHash: "hash-1",
  proposedByKind: "user",
  acceptedByKind: "user",
  acceptedAt: "2026-10-01T00:00:00.000Z",
  createdAt: "2026-10-01T00:00:00.000Z",
  ...patch,
});

const accepted = version({});
const proposed = version({
  id: "00000000-0000-4000-8000-000000000802",
  versionNumber: 2,
  state: "proposed",
  instructions: "Use the agreement first, then the account defaults.",
  fieldBindings: [
    ...accepted.fieldBindings,
    { fieldKey: "due_date", label: "Due date", type: "date", requiredFor: "issue", overridable: true, protected: false, sources: ["transaction", "agreement"] },
  ],
  acceptedByKind: null,
  acceptedAt: null,
});

const invoice: CrmOperationDefinition = {
  id: "00000000-0000-4000-8000-000000000901",
  operationKey: "invoice",
  operationKind: "invoice",
  label: "Invoice",
  currentVersionId: accepted.id,
  status: "active",
  version: 5,
  versions: [proposed, accepted],
};

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
function unmount() {
  act(() => root.unmount());
  host.remove();
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

beforeEach(() => {
  vi.clearAllMocks();
  api.listCrmSellers.mockResolvedValue([seller]);
  api.listCrmCustomerAccounts.mockResolvedValue([account]);
  api.listCrmCommercialProfiles.mockResolvedValue([accountDefaults]);
  api.listCrmOperationDefinitions.mockResolvedValue([invoice]);
  referenceApi.listCrmReferenceDefinitions.mockResolvedValue([]);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.querySelectorAll("[data-base-ui-portal]").forEach((node) => node.remove());
});

describe("[COMP:app-web/crm-commercial-operations] commercial context UI", () => {
  it("lists the company's accounts with seller, billing details and a stricter-sensitivity badge", async () => {
    await mount(<CrmRecordAccounts workspaceId={WORKSPACE_ID} companyId={COMPANY_ID} canConfigure={false} />);
    expect(api.listCrmCustomerAccounts).toHaveBeenCalledWith(WORKSPACE_ID, { companyId: COMPANY_ID, includeArchived: true });
    const row = host.querySelector(`[data-crm-account="${ACCOUNT_ID}"]`)!;
    expect(row.textContent).toContain("Retainer account");
    expect(row.textContent).toContain("Example Studio");
    expect(row.textContent).toContain("1 Example Road");
    expect(row.textContent).toContain(t.noBillingContact);
    const badge = row.querySelector<HTMLElement>("[data-commercial-sensitivity]")!;
    expect(badge.textContent).toBe(t.sensitivityLabels.confidential);
    expect(badge.dataset.stricter).toBe("true");
  });

  it("creates an account with seller, company and label, reusing the operation id on a network retry", async () => {
    api.listCrmCustomerAccounts.mockResolvedValue([]);
    api.executeCrmCommercialCommand
      .mockRejectedValueOnce(new CrmReferenceRequestError("network_error", null))
      .mockResolvedValueOnce({ command: "save_customer_account", record: { account }, created: true, duplicate: false, emittedEventIds: [] });
    await mount(<CrmRecordAccounts workspaceId={WORKSPACE_ID} companyId={COMPANY_ID} canConfigure={false} />);
    expect(host.textContent).toContain(t.accountsEmpty);
    await click(button(t.newAccount));
    await type(field(t.accountLabel), "Retainer account");
    await click(button(t.save));
    const first = api.executeCrmCommercialCommand.mock.calls[0][1];
    expect(first).toMatchObject({
      kind: "save_customer_account",
      account: { sellerKey: "example_studio", companyId: COMPANY_ID, label: "Retainer account", billingContactId: null, status: "active" },
    });
    expect(first.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.accountId).toBeUndefined();
    expect(first.classification).toBeUndefined();
    expect(host.textContent).toContain(t.uncertainWrite);

    await click(button(t.retryWrite));
    expect(api.executeCrmCommercialCommand).toHaveBeenCalledTimes(2);
    expect(api.executeCrmCommercialCommand.mock.calls[1][1]).toEqual(first);
    expect(host.textContent).toContain(t.accountSaved);
    expect(host.textContent).not.toContain(t.uncertainWrite);
  });

  it("explains a classification broader than its sources as a definite refusal", async () => {
    api.listCrmCustomerAccounts.mockResolvedValue([]);
    api.executeCrmCommercialCommand.mockRejectedValue(new CrmReferenceRequestError("invalid_input", 400,
      { reason: "classification_broader_than_source", minimum: "confidential" }));
    await mount(<CrmRecordAccounts workspaceId={WORKSPACE_ID} companyId={COMPANY_ID} canConfigure={false} />);
    await click(button(t.newAccount));
    await type(field(t.accountLabel), "Retainer account");
    await click(button(t.save));
    expect(host.textContent).toContain(t.refusals.classification_broader_than_source.replace("{minimum}", "Confidential"));
    expect(button(t.retryWrite)).toBeUndefined();
  });

  it("previews resolution with each field's source and groups the open questions", async () => {
    api.resolveCrmCommercialFields.mockResolvedValue({
      operationVersionId: accepted.id,
      fields: {
        currency: { fieldKey: "currency", type: "currency", value: "EUR", source: { kind: "agreement", recordId: "p1", version: 2, effectiveFrom: null }, overridden: false },
        payment_terms: { fieldKey: "payment_terms", type: "string", value: "Net 30", source: { kind: "account", recordId: "p2", version: 1, effectiveFrom: null }, overridden: false },
        seller_name: { fieldKey: "seller_name", type: "string", value: "Example Studio Ltd", source: { kind: "seller", recordId: "p3", version: 3, effectiveFrom: null }, overridden: false },
        discount: { fieldKey: "discount", type: "percent", value: "0.1", source: { kind: "transaction", recordId: null, version: null, effectiveFrom: null }, overridden: true },
        po_number: { fieldKey: "po_number", type: "string", value: undefined, source: null, overridden: false },
      },
      questions: [
        { fieldKey: "po_number", label: "PO number", kind: "missing", requiredFor: "draft", question: "What is the PO number?" },
        { fieldKey: "due_date", label: "Due date", kind: "missing", requiredFor: "issue", question: "When is payment due?" },
        { fieldKey: "rate", label: "Rate", kind: "conflict", requiredFor: "draft", question: "Two agreements set different rates." },
        { fieldKey: "discount", label: "Discount", kind: "review_required", requiredFor: "never", question: "The override contradicts a protected term." },
      ],
      draftReady: false,
      issueReady: false,
      profileVersions: [],
    });
    await mount(<CrmRecordAccounts workspaceId={WORKSPACE_ID} companyId={COMPANY_ID} canConfigure={false} />);
    await click(button(t.resolveTitle));
    await type(field(t.businessDateOptional), "2026-10-12");
    await click(button(t.resolve));
    expect(api.resolveCrmCommercialFields).toHaveBeenCalledWith(WORKSPACE_ID, { operationKey: "invoice", accountId: ACCOUNT_ID, businessDate: "2026-10-12" });
    const source = (key: string) => host.querySelector(`[data-resolved-field="${key}"] [data-resolved-source]`)?.textContent;
    expect(source("currency")).toBe("Agreement v2");
    expect(source("payment_terms")).toBe("Account v1");
    expect(source("seller_name")).toBe("Seller v3");
    expect(source("discount")).toBe(`Transaction · ${t.overridden}`);
    expect(source("po_number")).toBe(t.noSource);
    expect(host.querySelector('[data-resolved-field="po_number"]')?.textContent).toContain(t.missingValue);
    expect(host.querySelector('[data-resolved-field="currency"]')?.textContent).toContain("Currency");
    expect(host.textContent).toContain(t.draftNotReady);
    const group = (key: string) => host.querySelector(`[data-question-group="${key}"]`)?.textContent ?? "";
    expect(group("draft")).toContain(t.questionGroups.draft);
    expect(group("draft")).toContain("PO number");
    expect(group("issue")).toContain(t.questionGroups.issue);
    expect(group("issue")).toContain("Due date");
    expect(group("conflict")).toContain("Rate");
    expect(group("review")).toContain(t.questionGroups.review);
  });

  it("accepts account terms against the version read, records does-not-apply, and reports a stale version", async () => {
    api.executeCrmCommercialCommand.mockRejectedValue(new CrmReferenceRequestError("conflict", 409, { reason: "stale_version", currentVersion: 4 }));
    await mount(<CrmRecordAccounts workspaceId={WORKSPACE_ID} companyId={COMPANY_ID} canConfigure />);
    await click(button(t.terms));
    expect(host.querySelector('[data-commercial-profile="account"]')?.textContent).toContain("Net 30");
    await click(button(t.acceptDefaults));
    const editor = host.querySelector("[data-commercial-profile-editor]")!;
    expect(editor.textContent).toContain(t.profileEditorTitle.replace("{version}", "3"));
    await click(Array.from(editor.querySelectorAll("button")).find((item) => item.textContent?.trim() === t.doesNotApply));
    await click(button(t.acceptTerms));
    expect(api.executeCrmCommercialCommand.mock.calls[0][1]).toMatchObject({
      kind: "accept_commercial_profile",
      owner: { kind: "account", accountId: ACCOUNT_ID },
      expectedCurrentVersion: 3,
      fields: { payment_terms: { type: "string", value: null } },
      effectiveFrom: null,
      effectiveTo: null,
      evidence: { kind: "manual" },
    });
    expect(host.textContent).toContain(t.refusals.stale_version.replace("{version}", "4"));
  });

  it("proposes an operation version against the definition version, then accepts it through a confirm that summarizes the change", async () => {
    api.executeCrmCommercialCommand.mockResolvedValue({ command: "ok", record: { version: { versionNumber: 2 } }, created: true, duplicate: false, emittedEventIds: [] });
    await mount(<CrmCommercialSettings workspaceId={WORKSPACE_ID} canConfigure />);
    const row = host.querySelector('[data-commercial-operation="invoice"]')!;
    expect(row.textContent).toContain(t.acceptedVersion.replace("{version}", "1"));
    expect(row.textContent).toContain(t.proposedVersion.replace("{version}", "2"));

    await click(button(t.proposeVersion));
    const instructions = field<HTMLTextAreaElement>(t.instructions);
    expect(instructions.value).toBe(proposed.instructions);
    await type(instructions, "Prefer the agreement.");
    expect(host.querySelector("[data-instructions-count]")?.textContent).toBe("21 / 20,000 characters");
    await click(button(t.propose));
    const proposal = api.executeCrmCommercialCommand.mock.calls[0][1];
    expect(proposal).toMatchObject({
      kind: "save_operation_definition",
      operationKey: "invoice",
      operationKind: "invoice",
      expectedVersion: 5,
      version: { instructions: "Prefer the agreement.", instructionSource: null, templateBinding: null, reviewPolicy: "direct", referenceDefinitionKey: null },
    });
    expect(proposal.version.fieldBindings.map((binding: { fieldKey: string }) => binding.fieldKey)).toEqual(["currency", "due_date"]);
    expect(proposal.version.fieldBindings[1].sources).toEqual(["transaction", "agreement"]);
    expect(host.textContent).toContain(t.proposedDone);

    await click(button(t.accept));
    const options = vi.mocked(confirmDialog).mock.calls[0][0];
    expect(options.title).toBe(t.acceptTitle.replace("{version}", "2").replace("{name}", "Invoice"));
    const summary = renderToStaticMarkup(<>{options.content}</>);
    expect(summary).toContain(t.diffInstructionsChanged);
    expect(summary).toContain(t.diffAdded.replace("{keys}", "due_date"));
    expect(api.executeCrmCommercialCommand.mock.calls[1][1]).toMatchObject({
      kind: "accept_operation_version",
      operationKey: "invoice",
      versionId: proposed.id,
      expectedVersion: 5,
    });
    expect(host.textContent).toContain(t.acceptedDone.replace("{version}", "2"));
  });

  it("shows members commercial context read-only, without mutation controls", async () => {
    api.listCrmCommercialProfiles.mockResolvedValue([{ ...accountDefaults, ownerKind: "seller", accountId: null, sellerId: seller.id, sensitivity: "internal" }]);
    await mount(<CrmCommercialSettings workspaceId={WORKSPACE_ID} canConfigure={false} />);
    expect(host.textContent).toContain(t.readOnly);
    expect(host.textContent).toContain("Example Studio");
    expect(host.textContent).toContain(t.proposedVersion.replace("{version}", "2"));
    for (const label of [t.newSeller, t.edit, t.newOperation, t.proposeVersion, t.accept]) expect(button(label)).toBeUndefined();
    await click(button(t.defaultTerms));
    expect(host.querySelector("[data-commercial-seller-terms]")?.textContent).toContain("Net 30");
    expect(button(t.acceptDefaults)).toBeUndefined();
    unmount();

    await mount(<CrmRecordAccounts workspaceId={WORKSPACE_ID} companyId={COMPANY_ID} canConfigure={false} />);
    await click(button(t.terms));
    expect(host.querySelector("[data-crm-account-terms]")).toBeTruthy();
    expect(button(t.acceptDefaults)).toBeUndefined();
    expect(button(t.newAgreement)).toBeUndefined();
    expect(api.executeCrmCommercialCommand).not.toHaveBeenCalled();
  });
});
