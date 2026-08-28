/**
 * The Plan rail as the docked plan chat (docs/plans/feed-plan-chat-first.md
 * P1-P3): the preset context header the assistant plans from, the proposal
 * cardboard, and the quick-action chips that replaced the header's split
 * button — all above the shared `TuningChatPanel` hosting the
 * `channel_id='plan'` session.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { ProposedSlot } from "@/lib/feed-plan-proposal";

vi.mock("@/components/feed/tuning-chat-panel", () => ({
  TuningChatPanel: (props: { docked?: boolean; channelId?: string }) => (
    <div
      data-mock-tuning-panel
      data-docked={props.docked ? "yes" : "no"}
      data-channel={props.channelId}
    />
  ),
}));

vi.mock("@/lib/recorder/dock-recorder-bridge", () => ({
  useGlobalDockRecorder: () => null,
}));

vi.mock("@/lib/api/feed", () => ({
  ensurePlanSession: vi.fn(async () => ({ sessionId: "s1", channelId: "plan" })),
  fetchFeedVoiceMemories: vi.fn(async () => ({ memories: [], total: 0 })),
}));

import { PlanChatRail } from "../plan-chat-rail";

const dict = en as unknown as Dictionary;

const emptyCounts = {
  planned: 0,
  drafting: 0,
  ready: 0,
  posted: 0,
  skipped: 0,
};

function renderRail(
  overrides: Partial<React.ComponentProps<typeof PlanChatRail>> = {},
): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <PlanChatRail
        assistantId="a1"
        assistantName="Brian"
        workspaceId="w1"
        month="2026-08"
        brief={null}
        counts={emptyCounts}
        openIdeasCount={0}
        canEdit
        proposals={[]}
        showProposals={false}
        pullingProposals={false}
        acceptingProposalIndex={null}
        quickActions={[
          { key: "fill-empty", label: en.feedPage.plan.quickFillEmpty, run: vi.fn() },
          { key: "plan-week", label: en.feedPage.plan.quickPlanWeek, run: vi.fn() },
          {
            key: "review-month",
            label: en.feedPage.plan.quickReviewMonth,
            run: vi.fn(),
          },
        ]}
        onAcceptProposal={vi.fn()}
        onAcceptAllProposals={vi.fn()}
        onDismissProposal={vi.fn()}
        onRefreshProposals={vi.fn()}
        onOpenBrief={vi.fn()}
        onTurnComplete={vi.fn()}
        onActivate={vi.fn()}
        {...overrides}
      />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/feed-plan-chat] docked plan chat rail", () => {
  it("hosts the docked TuningChatPanel on the plan channel", () => {
    const html = renderRail();
    expect(html).toContain("data-mock-tuning-panel");
    expect(html).toContain('data-docked="yes"');
    expect(html).toContain('data-channel="plan"');
  });

  it("context header: unset brief invites setup; a written brief shows its first line + cadence", () => {
    const empty = renderRail();
    expect(empty).toContain("data-plan-context-header");
    expect(empty).toContain(en.feedPage.plan.contextBriefUnset);
    expect(empty).toContain(en.feedPage.plan.contextCadenceUnset);

    const withBrief = renderRail({
      brief: {
        month: "2026-08",
        brief: "Launch-focused month\nMore detail below",
        themes: ["launch"],
        cadencePerWeek: 3,
        updatedAt: "2026-08-01T00:00:00.000Z",
      } as never,
      openIdeasCount: 4,
    });
    expect(withBrief).toContain("Launch-focused month");
    expect(withBrief).not.toContain("More detail below");
    expect(withBrief).toContain("3/week");
    expect(withBrief).toContain("4 ideas waiting");
  });

  it("quick-action chips render for editors and vanish read-only", () => {
    const html = renderRail();
    expect(html).toContain(en.feedPage.plan.quickFillEmpty);
    expect(html).toContain(en.feedPage.plan.quickPlanWeek);
    expect(html).toContain(en.feedPage.plan.quickReviewMonth);

    const readOnly = renderRail({ canEdit: false });
    expect(readOnly).not.toContain(en.feedPage.plan.quickFillEmpty);
  });

  it("proposal cardboard keeps the explicit accept-before-write boundary (D19)", () => {
    const proposal: ProposedSlot = {
      index: 0,
      platform: "threads",
      date: "2026-08-12",
      title: "Launch teaser",
      brief: "Tease the launch",
      slotId: null,
    } as never;
    const html = renderRail({ showProposals: true, proposals: [proposal] });
    expect(html).toContain(en.feedPage.plan.proposedHeading);
    expect(html).toContain("Launch teaser");
    expect(html).toContain(en.feedPage.plan.acceptSlot);
    expect(html).toContain(en.feedPage.plan.dismissSlot);

    // Absent until the operator asks or a saved proposal exists.
    expect(renderRail()).not.toContain(en.feedPage.plan.proposedHeading);
  });
});
