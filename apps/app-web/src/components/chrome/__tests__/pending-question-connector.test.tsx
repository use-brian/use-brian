/**
 * [COMP:app-web/connector-authorization]
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PendingQuestionPanel } from "../pending-question-panel";
import { en } from "@/lib/i18n/dictionaries/en";

const common = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  approvalId: "22222222-2222-4222-8222-222222222222",
  dict: en.chat.pendingQuestion,
  onAnswered: vi.fn(),
  onCancelled: vi.fn(),
};

describe("[COMP:app-web/connector-authorization] pending connector checkpoint", () => {
  it("renders Connect instead of a free-text answer for a connector action", () => {
    const html = renderToStaticMarkup(
      <PendingQuestionPanel
        {...common}
        action={{
          kind: "connector_authorization",
          provider: "gcal",
          label: "Google Calendar",
          connectPath:
            "/w/workspace/studio/connectors?connect=gcal&setupSession=session&setupApproval=approval",
        }}
      />,
    );

    expect(html).toContain("Connect Google Calendar");
    expect(html).toContain("Authorize Google Calendar");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain(en.chat.pendingQuestion.submit);
    expect(html).toContain(en.chat.pendingQuestion.cancel);
  });

  it("keeps the ordinary free-text question surface unchanged", () => {
    const html = renderToStaticMarkup(<PendingQuestionPanel {...common} action={null} />);
    expect(html).toContain("<textarea");
    expect(html).toContain(en.chat.pendingQuestion.submit);
    expect(html).not.toContain("Connect Google Calendar");
  });
});
