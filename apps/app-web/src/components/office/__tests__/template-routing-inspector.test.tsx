import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { OfficeTemplateRoutingDraft } from "@use-brian/office-model";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { TemplateRoutingInspector, recipeForSelectedTargets, templateRecipeName } from "../template-routing-inspector";
import { presentationFixture, uid } from "./editor-fixtures";

function routing(): OfficeTemplateRoutingDraft {
  return {
    source: "upload",
    fields: [{ id: uid(90), name: "cover.content-1", label: "Presentation title", type: "richText", required: true, repeating: false, minItems: 0, maxItems: 1, maxLength: 300, targetIds: [uid(70)], aiInstruction: "Write the title.", locked: false }],
    slideRecipes: [{ id: uid(91), slideId: uid(63), name: "Opening", role: "cover", whenToUse: "Use first.", whenNotToUse: "Do not repeat.", enabled: true, repeatable: false, minUses: 0, maxUses: 1, fieldIds: [uid(90)], confidence: 0.83, inference: "The first slide is the proposed cover.", reviewed: false }],
  };
}

describe("[COMP:app-web/office-template-routing] Template routing inspector", () => {
  it("keeps reconciled slide recipe names within the registry contract", () => {
    expect(templateRecipeName("  A   short title  ", 0)).toBe("A short title");
    expect(templateRecipeName("   ", 1)).toBe("Slide 2");
    const bounded = templateRecipeName("A".repeat(240), 2);
    expect(bounded).toHaveLength(200);
    expect(bounded.endsWith("...")).toBe(true);
  });

  it("shows the selected slide recipe, Brian's rationale, and the mapped object field", () => {
    const snapshot = presentationFixture();
    const draft = routing();
    expect(recipeForSelectedTargets(draft, snapshot, [uid(70)])?.id).toBe(uid(91));
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en}><TemplateRoutingInspector templateId={uid(92)} snapshot={snapshot} selectedTargetIds={[uid(70)]} initialRouting={draft} /></I18nProvider>);
    expect(html).toContain('data-template-routing="ready"');
    expect(html).toContain('data-template-routing-field="selected"');
    expect(html).toContain("Slide routing");
    expect(html).toContain("Brian confidence: 83%");
    expect(html).toContain("Presentation title");
    expect(html).toContain("Mapped to the selected object");
    expect(html).toContain("Save routing");
  });
});
