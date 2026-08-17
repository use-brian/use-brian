/**
 * [COMP:app-web/plan-slot-chip] [COMP:app-web/plan-calendar]
 * [COMP:app-web/plan-list]
 *
 * Static render contracts for the two calendar-depth surfaces. Both are
 * rendered with `renderToString`, so what is pinned here is what the operator
 * SEES, which is exactly where the two views could drift apart.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { PlanProposalChip, PlanSlotChip } from "../plan-slot-chip";
import { PlanCalendar } from "../plan-calendar";
import { PlanList } from "../plan-list";
import type { PlanSlot } from "@/lib/feed-plan";
import type { ProposedSlot } from "@/lib/feed-plan-proposal";

const dict = en as unknown as Dictionary;
const TODAY = new Date(2026, 7, 15);

function slot(overrides: Partial<PlanSlot> = {}): PlanSlot {
  return {
    id: "slot-1",
    assistantId: "assistant-1",
    platform: "threads",
    scheduledFor: "2026-08-04",
    scheduledMinute: null,
    title: "Launch recap",
    brief: null,
    media: [],
    status: "planned",
    draftId: null,
    sessionId: null,
    createdBy: "user-1",
    createdAt: "2026-07-29T01:00:00Z",
    updatedAt: "2026-07-29T01:00:00Z",
    ...overrides,
  };
}

function render(node: React.ReactElement): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      {node}
    </I18nProvider>,
  );
}

function chip(s: PlanSlot, canEdit = true): string {
  return render(
    <PlanSlotChip
      slot={s}
      selected={false}
      canEdit={canEdit}
      dragging={false}
      onSelect={() => {}}
      onDragStart={() => {}}
      onDragEnd={() => {}}
      onDuplicate={() => {}}
      onDelete={() => {}}
    />,
  );
}

describe("[COMP:app-web/plan-slot-chip] Slot chip", () => {
  it("shows a time only when one is set", () => {
    // Untimed is a real and common state. Rendering "00:00" for it would
    // invent a time the operator never chose.
    expect(chip(slot({ scheduledMinute: 540 }))).toContain("09:00");
    expect(chip(slot({ scheduledMinute: null }))).not.toContain(":00");
  });

  it("carries the platform glyph and the title", () => {
    const html = chip(slot());
    expect(html).toContain('data-platform-icon="threads"');
    expect(html).toContain("Launch recap");
  });

  it("exposes an actions menu but never a publish action", () => {
    // D29: one-click publish from a calendar chip is how a wrong post ships.
    // The menu ITEMS are portalled and only render on open, so this pins the
    // trigger plus the absence of any publish affordance in the chip itself.
    const html = chip(slot());
    expect(html).toContain(en.feedPage.plan.slotActions);
    expect(html.toLowerCase()).not.toContain("post now");
  });

  it("hides the actions menu when the operator cannot edit", () => {
    expect(chip(slot(), false)).not.toContain(en.feedPage.plan.slotActions);
  });
});

describe("[COMP:app-web/plan-slot-chip] Proposal chip", () => {
  const proposal: ProposedSlot = {
    index: 1,
    date: "2026-08-18",
    platform: "threads",
    title: "What changed after launch",
  };

  it("looks pending and repeats the explicit Add / Dismiss boundary", () => {
    const html = render(
      <PlanProposalChip
        proposal={proposal}
        canEdit
        accepting={false}
        onAccept={() => {}}
        onDismiss={() => {}}
      />,
    );

    expect(html).toContain('data-plan-proposal-chip="1"');
    expect(html).toContain("border-dashed");
    expect(html).toContain("What changed after launch");
    expect(html).toContain(
      `${en.feedPage.plan.acceptSlot}: What changed after launch`,
    );
    expect(html).toContain(
      `${en.feedPage.plan.dismissSlot}: What changed after launch`,
    );
    expect(html).not.toContain('draggable="true"');
  });
});

describe("[COMP:app-web/plan-calendar] proposal previews", () => {
  it("places pending proposals on their dates without turning them into slots", () => {
    const proposals: ProposedSlot[] = [
      {
        index: 1,
        date: "2026-08-18",
        platform: "threads",
        title: "What changed after launch",
      },
      {
        index: 2,
        date: "2026-08-20",
        platform: "twitter",
        title: "Three sharp lessons",
      },
    ];
    const html = render(
      <PlanCalendar
        month="2026-08"
        slots={[]}
        proposals={proposals}
        today={TODAY}
        selectedSlotId={null}
        canEdit
        onMonthChange={() => {}}
        onAddOnDay={() => {}}
        onSelectSlot={() => {}}
        onReschedule={() => {}}
        onAcceptProposal={() => {}}
        onAcceptAllProposals={() => {}}
        onDismissProposal={() => {}}
      />,
    );

    expect(html).toContain("data-plan-proposal-summary");
    expect(html).toContain(en.feedPage.plan.proposedHeading);
    expect(html).toContain(en.feedPage.plan.acceptAll);
    expect(html.match(/data-plan-proposal-chip=/g)).toHaveLength(2);
    expect(html).toContain("What changed after launch");
    expect(html).toContain("Three sharp lessons");
    expect(html).not.toContain("data-status-dot");
  });
});

describe("[COMP:app-web/plan-list] Agenda view", () => {
  function list(slots: PlanSlot[], cadence: number | null = null): string {
    return render(
      <PlanList
        month="2026-08"
        slots={slots}
        cadencePerWeek={cadence}
        today={TODAY}
        selectedSlotId={null}
        canEdit
        onAddOnDay={() => {}}
        onSelectSlot={() => {}}
        onDuplicateSlot={() => {}}
        onDeleteSlot={() => {}}
      />,
    );
  }

  it("renders an empty state rather than 31 blank rows", () => {
    expect(list([])).toContain(en.feedPage.plan.listEmpty);
  });

  it("lists a day that has a slot, using the same chip as the grid", () => {
    const html = list([slot({ scheduledMinute: 540 })]);
    expect(html).toContain("Launch recap");
    expect(html).toContain("09:00");
    expect(html).toContain('data-platform-icon="threads"');
  });

  it("surfaces a cadence gap as a suggestion, not as a post", () => {
    const html = list([], 2);
    expect(html).toContain(en.feedPage.plan.gapSuggestion);
    // A ghost must never look like something that exists.
    expect(html).toContain("border-dashed");
  });
});
