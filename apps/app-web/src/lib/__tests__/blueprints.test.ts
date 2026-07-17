/**
 * [COMP:web/blueprints-library] Blueprint library helpers.
 *
 * Pure tests over the filter (templates -> blueprints), the picker-item
 * builder (workspace ids only — no built-ins), the section-count read, and the
 * blank-blueprint block seed. No React, no network — app-web's vitest is
 * node-only, so the component stays thin over these helpers.
 */

import { describe, expect, it } from "vitest";
import type { CustomPageTemplateSummary } from "@use-brian/doc-model";
import {
  blankBlueprintBlocks,
  blueprintSectionCount,
  buildBlueprintPickerItems,
  BUILTIN_BLUEPRINT_SLUGS,
  filterBlueprints,
  initialRecordingBlueprint,
  isBlueprint,
  recordingBlueprintToSlug,
  seedRecordingBlueprint,
  templateExtractionFromBlocks,
  RECORDING_INGEST_ONLY,
  RECORDING_UNSET,
} from "../blueprints";
import type { Block } from "@/lib/api/views";

/** Minimal template-summary factory — only the fields the helpers read. */
function tpl(
  over: Partial<CustomPageTemplateSummary> & { id: string; name: string },
): CustomPageTemplateSummary {
  return {
    workspaceId: "w1",
    createdBy: "u1",
    description: null,
    icon: null,
    category: "meeting",
    extraction: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const SPEC_ONE = {
  fields: [
    { key: "what", heading: "What", instruction: "pull X", type: "markdown" as const, required: false, outputType: "prose" as const },
  ],
  capture: [],
};
const SPEC_TWO = {
  fields: [
    { key: "a", heading: "A", instruction: "a", type: "markdown" as const, required: false, outputType: "prose" as const },
    { key: "b", heading: "B", instruction: "b", type: "markdown" as const, required: false, outputType: "list" as const },
  ],
  capture: ["company" as const],
};

describe("[COMP:web/blueprints-library] Blueprint library helpers", () => {
  describe("isBlueprint / filterBlueprints", () => {
    it("a template with an extraction spec is a blueprint; a plain skeleton is not", () => {
      expect(isBlueprint(tpl({ id: "1", name: "Brief", extraction: SPEC_ONE }))).toBe(true);
      expect(isBlueprint(tpl({ id: "2", name: "Skeleton", extraction: null }))).toBe(false);
    });

    it("keeps only blueprints and sorts them by name", () => {
      const all = [
        tpl({ id: "z", name: "Zeta brief", extraction: SPEC_ONE }),
        tpl({ id: "s", name: "Plain doc", extraction: null }),
        tpl({ id: "a", name: "Alpha capture", extraction: SPEC_TWO }),
      ];
      const result = filterBlueprints(all);
      expect(result.map((b) => b.id)).toEqual(["a", "z"]);
    });

    it("returns an empty list when no template carries a spec", () => {
      expect(
        filterBlueprints([tpl({ id: "1", name: "A" }), tpl({ id: "2", name: "B" })]),
      ).toEqual([]);
    });
  });

  describe("blueprintSectionCount", () => {
    it("counts the contract's fields, or 0 for a skeleton", () => {
      expect(blueprintSectionCount(tpl({ id: "1", name: "x", extraction: SPEC_TWO }))).toBe(2);
      expect(blueprintSectionCount(tpl({ id: "2", name: "y", extraction: null }))).toBe(0);
    });
  });

  describe("buildBlueprintPickerItems", () => {
    it("there are no built-in blueprints — the slug set is empty", () => {
      expect(BUILTIN_BLUEPRINT_SLUGS).toEqual([]);
    });

    it("lists only the workspace blueprints (by id), name-sorted", () => {
      const items = buildBlueprintPickerItems([
        tpl({ id: "ws-2", name: "Quarterly review", extraction: SPEC_ONE }),
        tpl({ id: "ws-1", name: "Account brief", extraction: SPEC_TWO }),
      ]);
      // Workspace blueprints, name-sorted (Account before Quarterly), valued by
      // template id (not slug). No built-ins precede them.
      expect(items).toEqual([
        { value: "ws-1", label: "Account brief" },
        { value: "ws-2", label: "Quarterly review" },
      ]);
    });

    it("excludes plain skeletons from the workspace items", () => {
      const items = buildBlueprintPickerItems([
        tpl({ id: "skeleton", name: "Just a doc", extraction: null }),
        tpl({ id: "bp", name: "Real blueprint", extraction: SPEC_ONE }),
      ]);
      expect(items.map((i) => i.value)).toEqual(["bp"]);
    });

    it("yields an empty list when the workspace has no blueprints", () => {
      expect(buildBlueprintPickerItems([])).toEqual([]);
    });
  });

  describe("recording upload selection ladder (migration 291)", () => {
    describe("initialRecordingBlueprint (pre-select vs ask)", () => {
      it("pre-selects the workspace default when one is configured (auto-apply)", () => {
        expect(initialRecordingBlueprint("tpl-default")).toBe("tpl-default");
      });

      it("leaves the picker UNSET when no default is set (prompt a choice, not a silent ingest-only)", () => {
        expect(initialRecordingBlueprint(null)).toBe(RECORDING_UNSET);
        expect(initialRecordingBlueprint(null)).not.toBe(RECORDING_INGEST_ONLY);
      });
    });

    describe("recordingBlueprintToSlug (submit mapping)", () => {
      it("submits a real blueprint id verbatim", () => {
        expect(recordingBlueprintToSlug("tpl-1")).toBe("tpl-1");
      });

      it("submits undefined (omit) for an explicit ingest-only pick", () => {
        expect(recordingBlueprintToSlug(RECORDING_INGEST_ONLY)).toBeUndefined();
      });

      it("submits undefined (omit) for the UNSET placeholder — ingest-only when never chosen", () => {
        expect(recordingBlueprintToSlug(RECORDING_UNSET)).toBeUndefined();
      });
    });

    describe("seedRecordingBlueprint (confirm-dialog picker seed)", () => {
      it("an explicit surface pick wins over the workspace default", () => {
        expect(seedRecordingBlueprint("tpl-picked", "tpl-default")).toBe("tpl-picked");
      });

      it("an explicit ingest-only pick is preserved (not overridden by the default)", () => {
        expect(seedRecordingBlueprint(RECORDING_INGEST_ONLY, "tpl-default")).toBe(
          RECORDING_INGEST_ONLY,
        );
      });

      it("no surface pick falls to the workspace default (chat dock / landing)", () => {
        expect(seedRecordingBlueprint(undefined, "tpl-default")).toBe("tpl-default");
      });

      it("an UNSET surface pick also falls to the workspace default", () => {
        expect(seedRecordingBlueprint(RECORDING_UNSET, "tpl-default")).toBe("tpl-default");
      });

      it("no pick and no default leaves the picker UNSET (prompt a choice)", () => {
        expect(seedRecordingBlueprint(undefined, null)).toBe(RECORDING_UNSET);
      });
    });
  });

  describe("blankBlueprintBlocks", () => {
    it("seeds a heading + an empty extraction slot with fresh ids", () => {
      let n = 0;
      const blocks = blankBlueprintBlocks(() => `id-${n++}`);
      expect(blocks).toEqual([
        { kind: "heading", id: "id-0", level: 2, text: "" },
        { kind: "extraction_slot", id: "id-1", instruction: "" },
      ]);
      // The slot is what makes this fillable — `blocksToExtractionSpec` (core)
      // pairs it with the heading to derive the spec.
      expect(blocks.some((b) => b.kind === "extraction_slot")).toBe(true);
    });
  });

  describe("templateExtractionFromBlocks (Save-as-template blueprint derivation)", () => {
    it("derives the spec so a WYSIWYG blueprint saves as a blueprint, not a skeleton", () => {
      // A page authored with heading + extraction_slot pairs must persist an
      // extraction spec — without it the saved template is a plain skeleton
      // (extraction null) and is hidden from the Blueprints library + pickers.
      const blocks = [
        { kind: "heading", id: "h1", level: 2, text: "Website" },
        { kind: "extraction_slot", id: "s1", instruction: "Pull the merchant site", outputType: "table" },
        { kind: "heading", id: "h2", level: 2, text: "Contacts" },
        { kind: "extraction_slot", id: "s2", instruction: "Verified contacts", outputType: "list" },
      ] as unknown as Block[];
      expect(templateExtractionFromBlocks(blocks)).toEqual({
        fields: [
          { key: "website", heading: "Website", instruction: "Pull the merchant site", type: "markdown", required: false, outputType: "table" },
          { key: "contacts", heading: "Contacts", instruction: "Verified contacts", type: "markdown", required: false, outputType: "list" },
        ],
        capture: [],
      });
    });

    it("returns undefined for a slot-free page (stays a plain template)", () => {
      const blocks = [
        { kind: "heading", id: "h1", level: 1, text: "Notes" },
        { kind: "paragraph", id: "p1", text: "just prose" },
      ] as unknown as Block[];
      expect(templateExtractionFromBlocks(blocks)).toBeUndefined();
    });
  });
});
