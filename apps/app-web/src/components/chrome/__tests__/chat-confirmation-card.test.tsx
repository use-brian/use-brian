// @vitest-environment jsdom
/**
 * [COMP:app-web/chat-confirmation-card] Chat Approve/Deny card previews.
 *
 * The card must make a recognised tool call proofreadable: a
 * `gmailSendMessage` confirmation renders the email preview (recipient,
 * subject, markdown-rendered body) parsed from the confirmation's `input`,
 * and suppresses the tool's model-facing `description` + the narrating
 * `displayLines`. Unrecognised tools keep the description/displayLines
 * card. Approve/Deny always fire with the toolCallId.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";
import type { PendingConfirmation } from "@use-brian/chat-ui";
import { ChatConfirmationCard } from "../chat-confirmation-card";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const dict = en as unknown as Dictionary;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

function render(ui: React.ReactNode) {
  if (root) act(() => root!.unmount());
  host?.remove();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <I18nProvider locale="en" dict={dict}>
        {ui}
      </I18nProvider>,
    );
  });
}

const TOOL_DESCRIPTION =
  "Send an email via Gmail. Call this tool directly and never guess an alias.";

function confirmation(
  overrides: Partial<PendingConfirmation> = {},
): PendingConfirmation {
  return {
    toolCallId: "call-1",
    toolName: "gmailSendMessage",
    displayName: "Send email",
    input: {
      to: "alice@example.com",
      subject: "Q2 report",
      body: "Hi Alice,\n\nThe **final** numbers are in.",
    },
    description: TOOL_DESCRIPTION,
    sessionId: "s-1",
    status: "pending",
    ...overrides,
  };
}

function renderCard(conf: PendingConfirmation, handlers?: {
  onApprove?: (id: string) => void;
  onDeny?: (id: string) => void;
}) {
  render(
    <ChatConfirmationCard
      confirmation={conf}
      approveLabel="Approve"
      denyLabel="Deny"
      approvingLabel="Approving"
      onApprove={handlers?.onApprove ?? (() => {})}
      onDeny={handlers?.onDeny ?? (() => {})}
    />,
  );
}

describe("[COMP:app-web/chat-confirmation-card] ChatConfirmationCard", () => {
  it("renders an email send as a proofreadable email, not the tool description", () => {
    renderCard(confirmation());
    const text = host!.textContent ?? "";
    expect(text).toContain("alice@example.com");
    expect(text).toContain("Q2 report");
    expect(text).toContain("The final numbers are in.");
    // Markdown is rendered, not shown as raw markers.
    expect(host!.querySelector("strong")?.textContent).toBe("final");
    expect(text).not.toContain("**final**");
    // The model-facing tool description is suppressed by the preview.
    expect(text).not.toContain("never guess an alias");
  });

  it("suppresses narrating displayLines when the preview renders, but keeps resolved attachment names", () => {
    renderCard(
      confirmation({
        input: {
          to: "alice@example.com",
          subject: "Q2 report",
          body: "Attached.",
          attachments: ["file-abc-123"],
        },
        displayLines: [
          "• To: alice@example.com",
          "• Subject: Q2 report",
          "• Body: Attached.",
          "• Attachment: q2-report.pdf (1.2 MB)",
        ],
      }),
    );
    const text = host!.textContent ?? "";
    expect(text).toContain("q2-report.pdf (1.2 MB)");
    // The bullet narration itself must not double-render.
    expect(text).not.toContain("• To:");
  });

  it("falls back to description + displayLines for unrecognised tools", () => {
    renderCard(
      confirmation({
        toolName: "deleteMemory",
        displayName: undefined,
        input: { memoryId: "m-1" },
        description: "Delete a saved memory.",
        displayLines: ["Memory: office wifi password location"],
      }),
    );
    const text = host!.textContent ?? "";
    expect(text).toContain("Delete a saved memory.");
    expect(text).toContain("Memory: office wifi password location");
  });

  it("fires onApprove/onDeny with the toolCallId and disables while approving", () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    renderCard(confirmation(), { onApprove, onDeny });
    const buttons = Array.from(host!.querySelectorAll("button"));
    const approve = buttons.find((b) => b.textContent === "Approve")!;
    const deny = buttons.find((b) => b.textContent === "Deny")!;
    act(() => approve.click());
    act(() => deny.click());
    expect(onApprove).toHaveBeenCalledWith("call-1");
    expect(onDeny).toHaveBeenCalledWith("call-1");

    renderCard(confirmation({ status: "approving" }));
    const inFlight = Array.from(host!.querySelectorAll("button"));
    expect(inFlight.every((b) => b.disabled)).toBe(true);
    expect(inFlight.some((b) => b.textContent === "Approving")).toBe(true);
  });
});
