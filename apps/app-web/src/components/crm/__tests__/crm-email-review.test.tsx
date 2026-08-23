// @vitest-environment jsdom

/** [COMP:app-web/crm-email-review] Dedicated CRM email review workspace. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchEmailReviewContext = vi.fn();
const respondByKind = vi.fn();
const reviseEmailApproval = vi.fn();
vi.mock("@/lib/api/approvals", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api/approvals")>();
  return {
    ...original,
    fetchEmailReviewContext: (...args: unknown[]) => fetchEmailReviewContext(...args),
    respondByKind: (...args: unknown[]) => respondByKind(...args),
    reviseEmailApproval: (...args: unknown[]) => reviseEmailApproval(...args),
  };
});

import { CrmEmailReviewWorkspace } from "../crm-email-review";
import { I18nProvider } from "@/lib/i18n/client";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { en } from "@/lib/i18n/dictionaries/en";
import type { PendingApprovalRow } from "@/lib/api/approvals";
import type { CrmData } from "@/lib/api/crm";
import type { CrmEmailApprovalQueueItem } from "@/lib/crm-r2";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dict = en as unknown as Dictionary;
const contact = {
  id: "contact-1",
  name: "Jamie Example",
  email: "jamie@example.test",
  phone: "+1 555 0100",
  companyId: "company-1",
  tags: ["customer"],
  updatedAt: "2026-08-24T00:00:00.000Z",
};
const approval: PendingApprovalRow = {
  id: "approval-1",
  kind: "workflow_step",
  status: "pending",
  toolName: "imapSendMessage__sales_1a2b3c4d",
  arguments: {
    from: "team@example.test",
    to: ["jamie@example.test"],
    subject: "Re: Project update",
    body: "Thanks for the update. We can start next week.",
    inReplyTo: "INBOX:42",
  },
  approvalPayload: {
    displayLines: ["From: team@example.test"],
    emailDraftRevision: 2,
  },
  approverUserId: "user-1",
  originatingAssistantId: null,
  blockingSessionId: null,
  workflowRunId: "run-1",
  workflowStepRunId: "step-1",
  deliveryChannelType: "web",
  createdAt: "2026-08-24T00:00:00.000Z",
  expiresAt: null,
};
const data: CrmData = {
  contacts: [contact],
  companies: [{
    id: "company-1",
    name: "Example Company",
    domain: "example.test",
    tags: [],
    updatedAt: "2026-08-24T00:00:00.000Z",
  }],
  deals: [{
    id: "deal-1",
    name: "Website refresh",
    stage: "lead",
    amount: 5000,
    closeDate: null,
    contactId: "contact-1",
    companyId: "company-1",
    updatedAt: "2026-08-24T00:00:00.000Z",
  }],
};
const items: CrmEmailApprovalQueueItem[] = [{ approval, contacts: [contact] }];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider locale="en" dict={dict}>
        <CrmEmailReviewWorkspace
          workspaceId="workspace-1"
          data={data}
          items={items}
          selectedId={approval.id}
          loading={false}
          loadError={false}
          onSelect={vi.fn()}
          onReload={vi.fn()}
          onResolved={vi.fn()}
          onRevised={vi.fn()}
          onOpenContact={vi.fn()}
        />
      </I18nProvider>,
    );
  });
  await settle();
}

function button(text: string): HTMLButtonElement {
  const match = [...container!.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!match) throw new Error(`button not found: ${text}`);
  return match;
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchEmailReviewContext.mockResolvedValue({
    thread: {
      subject: "Project update",
      truncated: false,
      messages: [{
        id: "message-1",
        folder: "INBOX",
        from: "Jamie Example <jamie@example.test>",
        to: ["team@example.test"],
        cc: [],
        sentAt: "2026-08-23T12:00:00.000Z",
        subject: "Project update",
        body: "Could we start next week?",
        bodyTruncated: false,
      }],
    },
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("[COMP:app-web/crm-email-review] dedicated review workspace", () => {
  it("shows the queue, archived chain, CRM profile, draft, and send action together", async () => {
    await mount();

    expect(container!.textContent).toContain("Project update");
    expect(container!.textContent).toContain("Could we start next week?");
    expect(container!.textContent).toContain("Jamie Example");
    expect(container!.textContent).toContain("Website refresh");
    expect(container!.querySelector<HTMLTextAreaElement>("textarea")?.value)
      .toBe("Thanks for the update. We can start next week.");
    expect(button(dict.crmPage.r2.approveSend)).toBeTruthy();
    expect(fetchEmailReviewContext).toHaveBeenCalledWith("approval-1", "contact-1");
  });

  it("requires saving an edited body before approval", async () => {
    await mount();
    const textarea = container!.querySelector<HTMLTextAreaElement>("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
      .call(textarea, "Updated reply body");
    await act(async () => textarea.dispatchEvent(new Event("input", { bubbles: true })));

    expect(button(dict.crmPage.r2.saveRevision)).toBeTruthy();
    expect(container!.textContent).toContain(dict.crmPage.r2.saveBeforeApprove);
    expect([...container!.querySelectorAll("button")].some(
      (candidate) => candidate.textContent?.trim() === dict.crmPage.r2.approveSend,
    )).toBe(false);
  });
});
