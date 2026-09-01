import { describe, expect, it } from "vitest";
import type { WorkspaceSkillSummary } from "../api/skills";
import {
  buildSkillPatch,
  filterSkillsForLibrary,
  groupSkillsByCategory,
  hasLibraryFilter,
  partitionSkillsForLanding,
  skillGroupLabel,
  skillGroupOf,
  skillGroupOptions,
  skillRowIdFromPathname,
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
    category: "custom",
    blueprintId: null,
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

describe("[COMP:app-web/brain-skills-view] groupSkillsByCategory", () => {
  // Groups are an open vocabulary, so there is no fixed enum order to fall
  // back on. One rule covers a set nobody can enumerate: alphabetical by the
  // label the reader sees, unsorted last.
  it("orders groups alphabetically with the unsorted sink last", () => {
    const groups = groupSkillsByCategory([
      skill({ rowId: "a", name: "Alpha", category: "custom" }),
      skill({ rowId: "b", name: "Bravo", category: "Nutrition" }),
      skill({ rowId: "c", name: "Charlie", category: "Gym & Training" }),
      skill({ rowId: "d", name: "Delta", category: "research" }),
    ]);
    expect(groups.map((g) => g.category)).toEqual([
      "Gym & Training",
      "Nutrition",
      "research",
      "custom",
    ]);
  });

  // It sorts the LABEL, not the stored slug, so the order is right in the
  // reader's own language rather than in English.
  it("sorts by the translated label when one is given", () => {
    const labels: Record<string, string> = {
      research: "Zebra research",
      productivity: "Alpha productivity",
    };
    const groups = groupSkillsByCategory(
      [
        skill({ rowId: "a", category: "research" }),
        skill({ rowId: "b", category: "productivity" }),
      ],
      (g) => labels[g] ?? g,
    );
    expect(groups.map((g) => g.category)).toEqual(["productivity", "research"]);
  });

  it("preserves the incoming order within a group", () => {
    const groups = groupSkillsByCategory([
      skill({ rowId: "z", name: "Zulu", category: "productivity" }),
      skill({ rowId: "a", name: "Alpha", category: "productivity" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.skills.map((s) => s.rowId)).toEqual(["z", "a"]);
  });

  // Two rows agreeing on `skillGroupKey` are one heading, and the FIRST
  // spelling wins so the label does not flicker with map insertion order.
  it("collapses spellings that differ only in case or spacing", () => {
    const groups = groupSkillsByCategory([
      skill({ rowId: "a", category: "Gym & Training" }),
      skill({ rowId: "b", category: "gym  &  training" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.category).toBe("Gym & Training");
    expect(groups[0]!.skills.map((s) => s.rowId)).toEqual(["a", "b"]);
  });

  // A name outside the four built-ins is a workspace's own group now, not a
  // legacy value to fold away. Only an absent one is unsorted.
  it("keeps an unrecognized name and folds only a missing one", () => {
    const groups = groupSkillsByCategory([
      skill({ rowId: "a", category: "Sales Enablement" }),
      skill({ rowId: "b", category: undefined as unknown as string }),
      skill({ rowId: "c", category: "custom" }),
    ]);
    expect(groups.map((g) => g.category)).toEqual(["Sales Enablement", "custom"]);
    expect(groups[1]!.skills.map((s) => s.rowId)).toEqual(["b", "c"]);
  });

  it("returns nothing for an empty list", () => {
    expect(groupSkillsByCategory([])).toEqual([]);
  });

  it("normalizes one skill's group on its own", () => {
    expect(skillGroupOf({ category: "communication" })).toBe("communication");
    expect(skillGroupOf({ category: "  Nutrition " })).toBe("Nutrition");
    expect(skillGroupOf({})).toBe("custom");
  });
});

describe("[COMP:app-web/brain-skills-view] Group labels and options", () => {
  const labels = {
    productivity: "Productivity",
    communication: "Communication",
    research: "Research",
    custom: "Unsorted",
  };

  it("translates a built-in and shows a workspace group verbatim", () => {
    expect(skillGroupLabel("custom", labels)).toBe("Unsorted");
    expect(skillGroupLabel("Gym & Training", labels)).toBe("Gym & Training");
  });

  // A picker that cannot see the library's own group names is how a
  // free-text field forks into near-synonyms.
  it("offers every built-in plus every group the library uses", () => {
    const options = skillGroupOptions([
      { category: "Nutrition" },
      { category: "nutrition" },
      { category: "research" },
    ]);
    expect(options).toContain("Nutrition");
    expect(options.filter((o) => o.toLowerCase() === "nutrition")).toHaveLength(1);
    for (const builtin of ["productivity", "communication", "research", "custom"]) {
      expect(options).toContain(builtin);
    }
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
        category: "custom",
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
        category: "custom",
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
        category: "custom",
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
        category: "custom",
      }),
    ).toEqual({});
    expect(
      buildSkillPatch(noWhen, {
        name: noWhen.name,
        description: noWhen.description,
        whenToUse: "When invoicing",
        content: noWhen.content,
        category: "custom",
      }),
    ).toEqual({ whenToUse: "When invoicing" });
  });

  it("a new group lands in the patch, and re-typing the same one does not", () => {
    const filed = skill({ ...base, category: "Gym & Training" });
    const draft = {
      name: filed.name,
      description: filed.description,
      whenToUse: filed.whenToUse ?? "",
      content: filed.content,
    };
    expect(buildSkillPatch(filed, { ...draft, category: "gym  &  training" })).toEqual({});
    expect(buildSkillPatch(filed, { ...draft, category: "  Nutrition " })).toEqual({
      category: "Nutrition",
    });
  });

  it("emptied name/content are dropped from the patch (the editor validates separately)", () => {
    expect(
      buildSkillPatch(base, {
        name: "",
        description: base.description,
        whenToUse: "On Fridays",
        content: "  ",
        category: "custom",
      }),
    ).toEqual({});
  });
});

describe("[COMP:app-web/brain-skill-editor] skillRowIdFromPathname", () => {
  it("extracts the row id from the skill editor route", () => {
    expect(
      skillRowIdFromPathname(
        "/w/ws-1/brain/skills/6f4a2c9e-1234-4abc-9def-0123456789ab",
      ),
    ).toBe("6f4a2c9e-1234-4abc-9def-0123456789ab");
  });

  it("ignores query and hash", () => {
    expect(skillRowIdFromPathname("/w/ws-1/brain/skills/row-9?x=1#top")).toBe(
      "row-9",
    );
  });

  it("returns null off the skill editor route", () => {
    expect(skillRowIdFromPathname(null)).toBeNull();
    expect(skillRowIdFromPathname(undefined)).toBeNull();
    expect(skillRowIdFromPathname("/w/ws-1/brain")).toBeNull();
    expect(skillRowIdFromPathname("/w/ws-1/brain/skills")).toBeNull();
    expect(skillRowIdFromPathname("/w/ws-1/p/page-1")).toBeNull();
    expect(skillRowIdFromPathname("/brain/skills/row-1")).toBeNull();
  });
});
