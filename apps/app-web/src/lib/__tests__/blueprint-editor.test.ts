/**
 * [COMP:web/blueprint-detail] Blueprint detail-editor draft logic.
 *
 * Pure tests over the draft round-trip (template -> draft -> spec), the
 * key-stability rule (existing keys never rederive; new keys derive from the
 * heading until touched), the client-side contract validation, and the dirty
 * diff that gates Save. No React, no network — the page component stays thin
 * over these helpers.
 */

import { describe, expect, it } from "vitest";
import type { ExtractionSpec } from "@sidanclaw/doc-model";
import {
  applyHeadingChange,
  applyKeyChange,
  buildTemplatePatch,
  draftFromTemplate,
  draftToExtraction,
  moveField,
  newDraftField,
  validateDraft,
  type BlueprintDraft,
} from "../blueprint-editor";

const SPEC: ExtractionSpec = {
  fields: [
    {
      key: "store-link",
      heading: "Store link",
      instruction: "The HKTV Mall store URL",
      type: "string",
      required: true,
    },
    {
      key: "business-focus",
      heading: "Business focus",
      instruction: "What the store sells and to whom",
      type: "markdown",
      required: false,
      outputType: "prose",
    },
  ],
  capture: ["company"],
};

function template(extraction: ExtractionSpec | null = SPEC) {
  return { name: "HKTV Mall Prospect Detail", description: "Prospect profile", extraction };
}

/** Deterministic uid source for stable assertions. */
function ids(): () => string {
  let n = 0;
  return () => `u${++n}`;
}

describe("[COMP:web/blueprint-detail] blueprint editor draft logic", () => {
  it("draftFromTemplate loads every field as existing with its saved key", () => {
    const draft = draftFromTemplate(template(), ids());
    expect(draft.name).toBe("HKTV Mall Prospect Detail");
    expect(draft.fields.map((f) => f.key)).toEqual(["store-link", "business-focus"]);
    expect(draft.fields.every((f) => f.existing)).toBe(true);
    expect(draft.fields[0].required).toBe(true);
  });

  it("editing an EXISTING field's heading never rederives its key (handoff address)", () => {
    const draft = draftFromTemplate(template(), ids());
    const edited = applyHeadingChange(draft.fields[0], "Shop URL");
    expect(edited.heading).toBe("Shop URL");
    expect(edited.key).toBe("store-link");
  });

  it("a NEW field derives its key from the heading until the key is touched", () => {
    let field = newDraftField(ids());
    field = applyHeadingChange(field, "Decision maker");
    expect(field.key).toBe("decision-maker");
    field = applyKeyChange(field, "dm");
    field = applyHeadingChange(field, "Champion");
    expect(field.key).toBe("dm");
  });

  it("moveField swaps neighbours and no-ops at the edges", () => {
    const draft = draftFromTemplate(template(), ids());
    const down = moveField(draft.fields, draft.fields[0].uid, "down");
    expect(down.map((f) => f.key)).toEqual(["business-focus", "store-link"]);
    expect(moveField(draft.fields, draft.fields[0].uid, "up")).toBe(draft.fields);
  });

  it("validateDraft mirrors the server contract rules", () => {
    const genId = ids();
    const base = draftFromTemplate(template(), genId);
    expect(validateDraft(base)).toEqual([]);

    const bad: BlueprintDraft = {
      name: " ",
      description: "",
      fields: [
        { ...base.fields[0], heading: "", instruction: "" },
        { ...base.fields[1], key: "store-link" },
        { ...newDraftField(genId), heading: "Tier", instruction: "x", key: "Bad Key", type: "enum", options: ["only-one"] },
        { ...newDraftField(genId), heading: "Owner", instruction: "x", key: "owner", type: "entityRef", entityKind: "" },
      ],
    };
    const codes = validateDraft(bad).map((i) => i.code);
    expect(codes).toContain("name-required");
    expect(codes).toContain("heading-required");
    expect(codes).toContain("instruction-required");
    expect(codes).toContain("key-duplicate");
    expect(codes).toContain("key-invalid");
    expect(codes).toContain("options-required");
    expect(codes).toContain("entity-kind-required");

    expect(validateDraft({ name: "x", description: "", fields: [] })).toEqual([
      { code: "fields-required" },
    ]);
  });

  it("draftToExtraction drops type-irrelevant state and keeps capture", () => {
    const draft = draftFromTemplate(template(), ids());
    // Stale enum options + entity kind linger in the draft after a type switch;
    // they must not leak into a string field's wire shape.
    draft.fields[0] = { ...draft.fields[0], options: ["a", "b"], entityKind: "company" };
    const spec = draftToExtraction(draft, ["company"]);
    expect(spec.fields[0]).toEqual({
      key: "store-link",
      heading: "Store link",
      instruction: "The HKTV Mall store URL",
      type: "string",
      required: true,
    });
    expect(spec.fields[1].outputType).toBe("prose");
    expect(spec.capture).toEqual(["company"]);
  });

  it("buildTemplatePatch is empty when clean and carries only the changed keys", () => {
    const draft = draftFromTemplate(template(), ids());
    expect(buildTemplatePatch(template(), draft)).toEqual({});

    const renamed = { ...draft, name: "Prospect Brief" };
    expect(buildTemplatePatch(template(), renamed)).toEqual({ name: "Prospect Brief" });

    const retyped = {
      ...draft,
      fields: [
        { ...draft.fields[0], instruction: "The store URL, verified" },
        draft.fields[1],
      ],
    };
    const patch = buildTemplatePatch(template(), retyped);
    expect(patch.name).toBeUndefined();
    expect(patch.extraction?.fields[0].instruction).toBe("The store URL, verified");
    expect(patch.extraction?.capture).toEqual(["company"]);
  });

  it("clearing the description patches it to null", () => {
    const draft = draftFromTemplate(template(), ids());
    const cleared = { ...draft, description: "" };
    expect(buildTemplatePatch(template(), cleared).description).toBeNull();
  });
});
