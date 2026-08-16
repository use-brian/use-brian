/**
 * The Plan rail shares the viewport's bottom-right corner with Feed chat.
 * Both variants reserve the same dock lane. The contextual planning companion
 * keeps repeat-use work in its overview and the monthly form on demand.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { PlanBriefRail } from "../plan-brief-rail";
import { PlanSlotPeek } from "../plan-slot-peek";

const dict = en as unknown as Dictionary;
const railSource = readFileSync(new URL("../plan-brief-rail.tsx", import.meta.url), "utf8");
const tooltipSource = readFileSync(new URL("../../ui/tooltip.tsx", import.meta.url), "utf8");

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

function renderBriefRail({
  view = "overview",
  watchToken = 0,
  brief = null,
}: {
  view?: "overview" | "brief";
  watchToken?: number;
  brief?: React.ComponentProps<typeof PlanBriefRail>["brief"];
} = {}): string {
  return render(
    <PlanBriefRail
      view={view}
      month="2026-08"
      brief={brief}
      counts={{ planned: 0, drafting: 0, ready: 0, posted: 0, skipped: 0 }}
      canEdit
      busy={false}
      assistantId="assistant-1"
      existingSlots={[]}
      ideas={[]}
      watchToken={watchToken}
      onSave={vi.fn()}
      onSlotsAccepted={vi.fn()}
      onAddIdea={async () => true}
      onDiscardIdea={vi.fn()}
      onPlanIdea={vi.fn()}
      onOpenBrief={vi.fn()}
      onCloseBrief={vi.fn()}
    />,
  );
}

describe("[COMP:app-web/plan-brief-rail] contextual planning companion", () => {
  it("defaults to repeat-use work with only a compact monthly-brief launcher", () => {
    const html = renderBriefRail();

    const briefAt = html.indexOf(en.feedPage.plan.briefHeading);
    const ideasAt = html.indexOf(en.feedPage.plan.ideasHeading);
    const progressAt = html.indexOf(en.feedPage.plan.progressHeading);

    expect(briefAt).toBeGreaterThan(-1);
    expect(ideasAt).toBeGreaterThan(briefAt);
    expect(progressAt).toBeGreaterThan(ideasAt);
    expect(html).toContain("data-plan-brief-launcher");
    expect(html).toContain(en.feedPage.plan.setUpBrief);
    expect(html).toContain(en.feedPage.plan.addIdea);
    expect(html).not.toContain(en.feedPage.plan.goalLabel);
    expect(html).not.toContain(en.feedPage.plan.themesLabel);
    expect(html).not.toContain("data-plan-brief-action");
    expect(html).not.toContain(en.feedPage.plan.proposedHeading);
  });

  it("opens the monthly form as a separate state", () => {
    const html = renderBriefRail({ view: "brief" });

    expect(html).toContain(en.feedPage.plan.goalLabel);
    expect(html).toContain(en.feedPage.plan.themesLabel);
    expect(html).toContain("data-plan-brief-action");
    expect(html).toContain(en.feedPage.plan.saveBrief);
    expect(html).toContain(en.feedPage.plan.backToBrief);
    expect(html).not.toContain("data-plan-brief-launcher");
    expect(html).not.toContain(en.feedPage.plan.ideasHeading);
    expect(html).not.toContain(en.feedPage.plan.progressHeading);
  });

  it("keeps guidance behind help controls and gives fields one focus layer", () => {
    const overviewHtml = renderBriefRail();
    const briefHtml = renderBriefRail({ view: "brief" });
    const html = `${overviewHtml}${briefHtml}`;
    const paragraphText = [...html.matchAll(/<p[^>]*>(.*?)<\/p>/g)]
      .map((match) => match[1].replace(/<[^>]+>/g, ""))
      .join(" ");

    expect(html).toContain('data-plan-section-help="brief"');
    expect(html).toContain('data-plan-section-help="cadence"');
    expect(html).toContain('data-plan-section-help="ideas"');
    expect(html).toContain('data-plan-section-help="progress"');
    expect(paragraphText).not.toContain(en.feedPage.plan.briefDescription);
    expect(paragraphText).not.toContain(en.feedPage.plan.cadenceHint);
    expect(paragraphText).not.toContain(en.feedPage.plan.ideasDescription);
    expect(paragraphText).not.toContain(en.feedPage.plan.progressDescription);
    expect(html).not.toContain(en.feedPage.plan.ideasEmpty);
    expect(overviewHtml.match(/focus-visible:shadow-none/g)).toHaveLength(1);
    expect(briefHtml.match(/focus-visible:shadow-none/g)).toHaveLength(3);
  });

  it("keeps each help tooltip visible when its trigger is clicked", () => {
    // Base UI closes ordinary action tooltips on press. These help buttons are
    // disclosures, so the rail controls their open state and explicitly keeps
    // the focused popup visible after the pointer press.
    expect(railSource).toContain("closeOnClick={false}");
    expect(railSource).toContain("onClick={() => setOpen(true)}");
    expect(tooltipSource).toContain(
      "open === undefined ? {} : { open, onOpenChange }",
    );
    expect(tooltipSource).toContain(
      "<TooltipPrimitive.Root {...rootControlProps}>",
    );
    expect(tooltipSource).toContain("closeOnClick={closeOnClick}");
  });

  it("reveals assistant proposals only after a planning request", () => {
    const html = renderBriefRail({ watchToken: 1 });

    expect(html).toContain(en.feedPage.plan.proposedHeading);
    expect(html).toContain(en.feedPage.plan.proposedDescription);
    expect(html).toContain(en.feedPage.plan.proposalsPending);
    expect(html).toContain(en.feedPage.plan.refreshProposals);
  });

  it("keeps the scroll body above the collapsed Feed dock", () => {
    const html = renderBriefRail();

    expect(html).toContain("data-plan-brief-scroll");
    expect(html).toContain("pb-20");
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
