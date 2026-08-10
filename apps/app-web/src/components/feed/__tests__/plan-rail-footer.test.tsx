/**
 * The Plan rail shares the viewport's bottom-right corner with Feed chat.
 * Both footer variants must reserve the same dock lane so no primary action
 * can be covered by the collapsed launcher.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { PlanBriefRail } from "../plan-brief-rail";
import { PlanSlotPeek } from "../plan-slot-peek";

const dict = en as unknown as Dictionary;

function render(child: React.ReactNode): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      {child}
    </I18nProvider>,
  );
}

function expectDockClearance(html: string) {
  expect(html).toContain("data-plan-rail-footer");
  expect(html).toContain("pb-20");
}

describe("[COMP:app-web/plan-brief-rail] dock-safe footer", () => {
  it("keeps Save above the collapsed Feed dock", () => {
    const html = render(
      <PlanBriefRail
        month="2026-08"
        brief={null}
        counts={{ planned: 0, drafting: 0, ready: 0, posted: 0, skipped: 0 }}
        canEdit
        busy={false}
        assistantId="assistant-1"
        existingSlots={[]}
        ideas={[]}
        watchToken={0}
        onSave={vi.fn()}
        onSlotsAccepted={vi.fn()}
        onAddIdea={async () => true}
        onDiscardIdea={vi.fn()}
        onPlanIdea={vi.fn()}
      />,
    );

    expectDockClearance(html);
    expect(html).toContain(en.feedPage.plan.saveBrief);
  });
});

describe("[COMP:app-web/plan-slot-peek] dock-safe footer", () => {
  it("keeps slot actions above the collapsed Feed dock", () => {
    const html = render(
      <PlanSlotPeek
        draft={{
          id: null,
          platform: "twitter",
          scheduledFor: "2026-08-03",
          scheduledMinute: null,
          title: "Launch note",
          brief: "Explain the release.",
        }}
        slot={null}
        canEdit
        busy={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
        onDelete={vi.fn()}
        onDraftThis={vi.fn()}
        onOpenDraft={vi.fn()}
        onToggleSkip={vi.fn()}
        onDiscuss={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    expectDockClearance(html);
    expect(html).toContain(en.feedPage.plan.createSlot);
  });
});
