/**
 * Capture-first strip (feed-plan-chat-first.md P5-P6, P8): ONE capture verb
 * — no idea-vs-post fork before the thought is down — with escalation
 * offered after the jot, and the relocated backlog tray beneath.
 */

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { FeedIdea } from "@/lib/feed-plan";
import { PlanCaptureStrip } from "../plan-capture-strip";

const dict = en as unknown as Dictionary;
const stripSource = readFileSync(
  new URL("../plan-capture-strip.tsx", import.meta.url),
  "utf8",
);

function idea(overrides: Partial<FeedIdea> = {}): FeedIdea {
  return {
    id: "idea-1",
    assistantId: "a1",
    text: "Our onboarding horror story as a thread",
    note: null,
    platformHint: null,
    source: "manual",
    status: "open",
    slotId: null,
    sessionId: null,
    discardedAt: null,
    createdBy: "user-1",
    createdAt: "2026-08-01T01:00:00.000Z",
    updatedAt: "2026-08-01T01:00:00.000Z",
    ...overrides,
  };
}

function renderStrip(
  overrides: Partial<React.ComponentProps<typeof PlanCaptureStrip>> = {},
): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <PlanCaptureStrip
        canEdit
        ideas={[]}
        busy={false}
        onLogIdea={async () => idea()}
        onDraftIdea={vi.fn()}
        onPlanIdea={vi.fn()}
        onDiscardIdea={vi.fn()}
        {...overrides}
      />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/feed-capture-strip] capture-first strip", () => {
  it("offers ONE capture verb: the input plus Log idea, no pre-capture fork", () => {
    const html = renderStrip();
    expect(html).toContain("data-plan-capture-strip");
    expect(html).toContain(en.feedPage.plan.capturePlaceholder);
    expect(html).toContain(en.feedPage.plan.captureLog);
    // Escalation labels only appear AFTER a jot is logged (P6) — never as
    // a competing capture-time choice.
    expect(html).not.toContain("data-plan-capture-escalation");
    expect(html).not.toContain(en.feedPage.plan.captureDraftNow);
  });

  it("escalates AFTER capture: Enter logs, then the row offers Draft now / Plan it", () => {
    // The submit handler resolves the saved jot, keeps it for the
    // escalation row, and the escalation hands exactly that idea over.
    expect(stripSource).toContain("const idea = await onLogIdea(trimmed)");
    expect(stripSource).toContain("setLogged(idea)");
    expect(stripSource).toContain("escalate(onDraftIdea)");
    expect(stripSource).toContain("escalate(onPlanIdea)");
    // Enter submits; Shift+Enter stays a newline; IME composition is safe.
    expect(stripSource).toContain('e.key === "Enter"');
    expect(stripSource).toContain("!e.shiftKey");
    expect(stripSource).toContain("!e.nativeEvent.isComposing");
  });

  it("read-only members browse the tray but get no input and no actions", () => {
    const html = renderStrip({ canEdit: false, ideas: [idea()] });
    expect(html).not.toContain(en.feedPage.plan.captureLog);
    expect(html).toContain("data-plan-ideas-toggle");
    // Count badge stays visible even collapsed.
    expect(html).toContain(en.feedPage.plan.ideasHeading);
  });

  it("backlog rows carry the full escalation set: Draft, Plan it, discard", () => {
    // The tray is collapsed by default; its rows come from the same source.
    expect(stripSource).toContain("onDraftIdea(idea)");
    expect(stripSource).toContain("onPlanIdea(idea)");
    expect(stripSource).toContain("onDiscardIdea(idea)");
    // Discard stays confirm-gated (the widget rail's contract).
    expect(stripSource).toContain("confirmDialog({");
    expect(stripSource).toContain("variant: \"destructive\"");
  });
});
