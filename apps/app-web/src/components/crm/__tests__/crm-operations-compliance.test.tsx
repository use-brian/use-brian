// @vitest-environment jsdom

/** [COMP:app-web/crm-operations] Submission Inbox and contact compliance parity. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  checkCrmSendability: vi.fn(),
  getCrmCompliance: vi.fn(),
  getCrmSubmission: vi.fn(),
  listCrmSubmissions: vi.fn(),
  recordCrmConsent: vi.fn(),
  recordCrmSuppression: vi.fn(),
  updateCrmSubmission: vi.fn(),
}));
vi.mock("@/lib/api/crm", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api/crm")>(),
  ...api,
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: vi.fn(async () => true) }));

import { CrmContactCompliance } from "../operations/contact-compliance";
import { CrmSubmissionInbox } from "../operations/submission-inbox";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE_ID = "workspace-1";
const CONTACT_ID = "00000000-0000-4000-8000-000000000010";
const SUBMISSION_ID = "00000000-0000-4000-8000-000000000020";
const purpose = {
  id: "00000000-0000-4000-8000-000000000030", purposeKey: "marketing",
  label: "Marketing", description: "", requiresConsent: true,
  applicableChannels: ["email" as const], wordingVersion: "v1", wording: "I agree",
  wordingHash: "hash", archivedAt: null,
  createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z",
};
const submission = {
  id: SUBMISSION_ID, contactId: CONTACT_ID, contactName: "Taylor Example",
  definitionId: purpose.id, definitionKey: "website_contact", definitionLabel: "Website contact",
  fields: { message: "Please call me" }, status: "new" as const, queueKey: "general",
  ownerUserId: null, followUpTaskId: null,
  submittedAt: "2026-08-30T00:00:00.000Z", createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z", notes: [],
};

let host: HTMLDivElement;
let root: Root;

async function settle() {
  for (let index = 0; index < 8; index += 1) await act(async () => { await Promise.resolve(); });
}
async function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<I18nProvider locale="en" dict={en}>{node}</I18nProvider>));
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getCrmCompliance.mockResolvedValue({
    purposes: [purpose], events: [], suppressions: [{
      id: "suppression-1", channel: "email", action: "suppressed",
      reasonCode: "manual_do_not_contact", source: "manual",
      occurredAt: "2026-08-30T00:00:00.000Z", createdAt: "2026-08-30T00:00:00.000Z",
    }],
  });
  api.checkCrmSendability.mockResolvedValue({
    verdict: "blocked", reasons: ["channel_suppression"],
    effectiveSuppressionEventIds: ["suppression-1"],
  });
  api.recordCrmConsent.mockResolvedValue({ record: {} });
  api.listCrmSubmissions.mockResolvedValue([submission]);
  api.getCrmSubmission.mockResolvedValue(submission);
  api.updateCrmSubmission.mockResolvedValue({ record: submission });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.querySelectorAll("[data-base-ui-portal]").forEach((node) => node.remove());
});

describe("[COMP:app-web/crm-operations] operations UI", () => {
  it("renders fail-closed sendability and writes consent through the canonical API", async () => {
    await mount(<CrmContactCompliance workspaceId={WORKSPACE_ID} contactId={CONTACT_ID} />);
    expect(host.textContent).toContain("Blocked");
    expect(host.textContent).toContain("Channel suppressed");
    const grant = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === en.crmPage.operations.grant,
    );
    await act(async () => grant?.click());
    await settle();
    expect(api.recordCrmConsent).toHaveBeenCalledWith(WORKSPACE_ID, CONTACT_ID, {
      purposeKey: "marketing", action: "granted", source: "manual",
    });
  });

  it("renders an addressable submission with captured fields and canonical status", async () => {
    const onSelect = vi.fn();
    await mount(<CrmSubmissionInbox workspaceId={WORKSPACE_ID} selectedId={SUBMISSION_ID} onSelect={onSelect} />);
    expect(host.textContent).toContain("Taylor Example");
    expect(host.textContent).toContain("Website contact");
    expect(host.textContent).toContain("Please call me");
    expect(api.listCrmSubmissions).toHaveBeenCalledWith(WORKSPACE_ID, { status: "new" });
    expect(api.getCrmSubmission).toHaveBeenCalledWith(WORKSPACE_ID, SUBMISSION_ID);
  });
});
