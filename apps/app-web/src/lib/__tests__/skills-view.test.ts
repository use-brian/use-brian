import { describe, expect, it } from "vitest";
import type { WorkspaceSkillSummary } from "../api/skills";
import {
  buildSkillPatch,
  filterSkillsForLibrary,
  hasLibraryFilter,
  partitionSkillsForLanding,
  skillStatus,
  suggestedSkillCount,
  type SkillLibraryFilter,
} from "../skills-view";

/** Minimal projection factory — only the fields the helpers read get
 *  meaningful defaults; everything else is inert. */
function skill(
  overrides: Partial<WorkspaceSkillSummary> = {},
): WorkspaceSkillSummary {
  return {
    rowId: "row-1",
    slug: "weekly-update",
    name: "Weekly update",
    description: "How we write the weekly update",
    whenToUse: null,
    content: "Step 1. Step 2.",
    state: "active",
    confidence: 0.9,
    activatedAt: "2026-06-01T00:00:00.000Z",
    inductionSource: "authored",
    sensitivity: "internal",
    sensitivityOverridden: false,
    originatingAssistantId: null,
    verifiedByUserId: null,
    verifiedAt: null,
    rederivationCount: 0,
    requiresConnectors: [],
    enabledAssistantIds: [],
    lastInvokedAt: null,
    invocations: 0,
    succeeded: 0,
    userCorrectedAfter: 0,
    ...overrides,
  };
}

const NO_FILTER: SkillLibraryFilter = {
  search: "",
  statuses: [],
  sources: [],
  sensitivities: [],
};

describe("[COMP:app-web/brain-topbar] suggestedSkillCount", () => {
  it("counts only suggested skills; stale-without-activation is not suggested", () => {
    expect(
      suggestedSkillCount([
        skill(),
        skill({ activatedAt: null }),
        skill({ activatedAt: null, state: "stale" }),
        skill({ activatedAt: null, rowId: "b" }),
      ]),
    ).toBe(2);
    expect(suggestedSkillCount([])).toBe(0);
  });
});

describe("[COMP:app-web/brain-skills-view] skillStatus", () => {
  it("activated + active state → active", () => {
    expect(skillStatus(skill())).toBe("active");
  });

  it("no activatedAt → suggested", () => {
    expect(skillStatus(skill({ activatedAt: null }))).toBe("suggested");
  });

  it("stale state wins over activation", () => {
    expect(skillStatus(skill({ state: "stale" }))).toBe("stale");
  });
});

describe("[COMP:app-web/brain-skills-view] partitionSkillsForLanding", () => {
  const active = skill({ rowId: "a", name: "Alpha procedure" });
  const suggested = skill({
    rowId: "b",
    name: "Beta procedure",
    activatedAt: null,
  });
  const stale = skill({ rowId: "c", name: "Gamma procedure", state: "stale" });

  it("unfiltered landing: suggested rows pin into the band, the list shows the rest (never twice)", () => {
    const { band, list } = partitionSkillsForLanding(
      [active, suggested, stale],
      NO_FILTER,
    );
    expect(band.map((s) => s.rowId)).toEqual(["b"]);
    expect(list.map((s) => s.rowId)).toEqual(["a", "c"]);
  });

  it("band is empty at zero suggested (no all-clear filler)", () => {
    const { band, list } = partitionSkillsForLanding([active, stale], NO_FILTER);
    expect(band).toEqual([]);
    expect(list.map((s) => s.rowId)).toEqual(["a", "c"]);
  });

  it("any armed filter collapses the band into the one plain filtered list", () => {
    const byStatus = partitionSkillsForLanding([active, suggested, stale], {
      ...NO_FILTER,
      statuses: ["suggested"],
    });
    expect(byStatus.band).toEqual([]);
    expect(byStatus.list.map((s) => s.rowId)).toEqual(["b"]);

    const bySearch = partitionSkillsForLanding([active, suggested, stale], {
      ...NO_FILTER,
      search: "beta",
    });
    expect(bySearch.band).toEqual([]);
    expect(bySearch.list.map((s) => s.rowId)).toEqual(["b"]);
  });

  it("hasLibraryFilter arms on search or any chip group, not on whitespace", () => {
    expect(hasLibraryFilter(NO_FILTER)).toBe(false);
    expect(hasLibraryFilter({ ...NO_FILTER, search: "   " })).toBe(false);
    expect(hasLibraryFilter({ ...NO_FILTER, search: "x" })).toBe(true);
    expect(hasLibraryFilter({ ...NO_FILTER, statuses: ["active"] })).toBe(true);
    expect(hasLibraryFilter({ ...NO_FILTER, sources: ["self"] })).toBe(true);
    expect(
      hasLibraryFilter({ ...NO_FILTER, sensitivities: ["public"] }),
    ).toBe(true);
  });
});

describe("[COMP:app-web/brain-skills-view] filterSkillsForLibrary", () => {
  const active = skill({ rowId: "a", name: "Alpha procedure" });
  const suggested = skill({
    rowId: "b",
    name: "Beta procedure",
    activatedAt: null,
    inductionSource: "self",
    sensitivity: "confidential",
  });
  const stale = skill({
    rowId: "c",
    name: "Gamma procedure",
    state: "stale",
    inductionSource: "ingested",
    sensitivity: "public",
    description: "legacy onboarding flow",
  });
  const all = [active, suggested, stale];

  it("no filter → everything, suggested first then active then stale", () => {
    const result = filterSkillsForLibrary(all, NO_FILTER);
    expect(result.map((s) => s.rowId)).toEqual(["b", "a", "c"]);
  });

  it("status chips are an OR within the group", () => {
    const result = filterSkillsForLibrary(all, {
      ...NO_FILTER,
      statuses: ["active", "stale"],
    });
    expect(result.map((s) => s.rowId)).toEqual(["a", "c"]);
  });

  it("source + sensitivity chips AND across groups", () => {
    const result = filterSkillsForLibrary(all, {
      ...NO_FILTER,
      sources: ["self", "ingested"],
      sensitivities: ["confidential"],
    });
    expect(result.map((s) => s.rowId)).toEqual(["b"]);
  });

  it("search matches name or description, case-insensitive", () => {
    expect(
      filterSkillsForLibrary(all, { ...NO_FILTER, search: "ALPHA" }).map(
        (s) => s.rowId,
      ),
    ).toEqual(["a"]);
    expect(
      filterSkillsForLibrary(all, { ...NO_FILTER, search: "onboarding" }).map(
        (s) => s.rowId,
      ),
    ).toEqual(["c"]);
  });

  it("search composes with chips", () => {
    const result = filterSkillsForLibrary(all, {
      ...NO_FILTER,
      search: "procedure",
      statuses: ["suggested"],
    });
    expect(result.map((s) => s.rowId)).toEqual(["b"]);
  });
});

describe("[COMP:app-web/brain-skill-editor] buildSkillPatch", () => {
  const base = skill({
    name: "Weekly update",
    description: "How we write it",
    whenToUse: "On Fridays",
    content: "Step 1.",
  });

  it("unchanged drafts → empty patch (Save stays disabled)", () => {
    expect(
      buildSkillPatch(base, {
        name: "Weekly update",
        description: "How we write it",
        whenToUse: "On Fridays",
        content: "Step 1.",
      }),
    ).toEqual({});
  });

  it("whitespace-only differences never count as changes", () => {
    expect(
      buildSkillPatch(base, {
        name: "  Weekly update  ",
        description: "How we write it ",
        whenToUse: " On Fridays",
        content: "Step 1.\n",
      }),
    ).toEqual({});
  });

  it("only changed fields land in the patch", () => {
    expect(
      buildSkillPatch(base, {
        name: "Weekly update",
        description: "How we write it",
        whenToUse: "On Fridays",
        content: "Step 1. Step 2.",
      }),
    ).toEqual({ content: "Step 1. Step 2." });
  });

  it("null whenToUse compares as empty, so clearing it is a no-op and setting it is a change", () => {
    const noWhen = skill({ whenToUse: null });
    expect(
      buildSkillPatch(noWhen, {
        name: noWhen.name,
        description: noWhen.description,
        whenToUse: "",
        content: noWhen.content,
      }),
    ).toEqual({});
    expect(
      buildSkillPatch(noWhen, {
        name: noWhen.name,
        description: noWhen.description,
        whenToUse: "When invoicing",
        content: noWhen.content,
      }),
    ).toEqual({ whenToUse: "When invoicing" });
  });

  it("emptied name/content are dropped from the patch (the editor validates separately)", () => {
    expect(
      buildSkillPatch(base, {
        name: "",
        description: base.description,
        whenToUse: "On Fridays",
        content: "  ",
      }),
    ).toEqual({});
  });
});
