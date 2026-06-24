import { describe, it, expect } from "vitest";
import {
  listPageTemplates,
  type CustomPageTemplateSummary,
} from "@sidanclaw/doc-model";

import { filterTemplates, filterCustomTemplates } from "../template-gallery";

// app-web vitest is node-only, so this covers the pure filter the gallery uses
// for keyboard / search; the DOM glue (Dialog, highlight) is not covered here.
describe("[COMP:app-web/template-gallery] filterTemplates", () => {
  const all = listPageTemplates();

  it("returns the whole catalog for an empty query", () => {
    expect(filterTemplates("", all)).toHaveLength(all.length);
    expect(filterTemplates("   ", all)).toHaveLength(all.length);
  });

  it("matches on the template name (case-insensitive)", () => {
    const matches = filterTemplates("MEETING", all);
    expect(matches.some((t) => t.id === "meeting-notes")).toBe(true);
  });

  it("matches on a keyword that is not in the visible name", () => {
    // "scrum" is a keyword of the daily standup template, not its name.
    const matches = filterTemplates("scrum", all);
    expect(matches.some((t) => t.id === "standup")).toBe(true);
  });

  it("matches on the description text", () => {
    const matches = filterTemplates("quarter", all);
    expect(matches.some((t) => t.id === "okrs")).toBe(true);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterTemplates("zzz-no-such-template", all)).toEqual([]);
  });
});

describe("[COMP:app-web/template-gallery] filterCustomTemplates", () => {
  const row = (
    over: Partial<CustomPageTemplateSummary> = {},
  ): CustomPageTemplateSummary => ({
    id: "ct_1",
    workspaceId: "ws",
    createdBy: "u",
    name: "Sprint plan",
    description: "Two-week sprint outline",
    icon: "🏃",
    category: "planning",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  });
  const custom = [
    row(),
    row({ id: "ct_2", name: "Client onboarding", description: null }),
  ];

  it("returns every row for an empty query", () => {
    expect(filterCustomTemplates("", custom)).toHaveLength(2);
    expect(filterCustomTemplates("   ", custom)).toHaveLength(2);
  });

  it("matches on name (case-insensitive)", () => {
    expect(filterCustomTemplates("SPRINT", custom).map((t) => t.id)).toEqual(["ct_1"]);
  });

  it("matches on description and tolerates a null description", () => {
    expect(filterCustomTemplates("two-week", custom).map((t) => t.id)).toEqual(["ct_1"]);
    // The null-description row still matches on its name.
    expect(filterCustomTemplates("onboarding", custom).map((t) => t.id)).toEqual(["ct_2"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterCustomTemplates("zzz", custom)).toEqual([]);
  });
});
