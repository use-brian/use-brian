/**
 * The Plan rail's overlays (feed-plan-chat-first.md P9): the extracted
 * month-brief editor and the slot peek, which open OVER the docked plan
 * chat and fold back to it. The widget rail they came from is retired.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { PlanBriefEditor } from "../plan-brief-editor";
import { PlanSlotPeek } from "../plan-slot-peek";

const dict = en as unknown as Dictionary;
const editorSource = readFileSync(
  new URL("../plan-brief-editor.tsx", import.meta.url),
  "utf8",
);
const tooltipSource = readFileSync(
  new URL("../../ui/tooltip.tsx", import.meta.url),
  "utf8",
);

function render(child: React.ReactNode): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      {child}
    </I18nProvider>,
  );
}

function renderBriefEditor(
  overrides: Partial<React.ComponentProps<typeof PlanBriefEditor>> = {},
): string {
  return render(
    <PlanBriefEditor
      brief={null}
      canEdit
      busy={false}
      onSave={vi.fn()}
      onBack={vi.fn()}
      {...overrides}
    />,
  );
}

describe("[COMP:app-web/feed-plan-brief-editor] month-brief overlay", () => {
  it("edits goal, themes, and cadence with an explicit save boundary and a way back to the chat", () => {
    const html = renderBriefEditor();

    expect(html).toContain(en.feedPage.plan.goalLabel);
    expect(html).toContain(en.feedPage.plan.themesLabel);
    expect(html).toContain(en.feedPage.plan.cadenceLabel);
    expect(html).toContain("data-plan-brief-action");
    expect(html).toContain(en.feedPage.plan.saveBrief);
    expect(html).toContain(en.feedPage.plan.backToBrief);
  });

  it("keeps guidance behind help disclosures and gives fields one focus layer", () => {
    const html = renderBriefEditor();
    const paragraphText = [...html.matchAll(/<p[^>]*>(.*?)<\/p>/g)]
      .map((match) => match[1].replace(/<[^>]+>/g, ""))
      .join(" ");

    expect(paragraphText).not.toContain(en.feedPage.plan.briefDescription);
    expect(paragraphText).not.toContain(en.feedPage.plan.cadenceHint);
    expect(html.match(/focus-visible:shadow-none/g)).toHaveLength(3);
  });

  it("keeps each help tooltip visible when its trigger is clicked", () => {
    // Base UI closes ordinary action tooltips on press. These help buttons are
    // disclosures, so the editor controls their open state and explicitly
    // keeps the focused popup visible after the pointer press.
    expect(editorSource).toContain("closeOnClick={false}");
    expect(editorSource).toContain("onClick={() => setOpen(true)}");
    expect(tooltipSource).toContain(
      "open === undefined ? {} : { open, onOpenChange }",
    );
    expect(tooltipSource).toContain(
      "<TooltipPrimitive.Root {...rootControlProps}>",
    );
    expect(tooltipSource).toContain("closeOnClick={closeOnClick}");
  });

  it("hides the save action read-only", () => {
    const html = renderBriefEditor({ canEdit: false });
    expect(html).not.toContain("data-plan-brief-action");
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

    expect(html).toContain("data-plan-rail-footer");
    expect(html).toContain("pb-20");
    expect(html).toContain(en.feedPage.plan.createSlot);
  });
});
