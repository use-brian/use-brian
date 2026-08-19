/**
 * Pure logic of the composer's slash-command autocomplete: when the menu may
 * open (the whole draft is a half-typed command word) and how candidates
 * rank. The popup interaction itself mirrors the mention autocomplete and
 * stays under gstack QA.
 * [COMP:app-web/slash-command-autocomplete]
 */

import { describe, expect, it } from "vitest";
import {
  filterSlashCommands,
  slashCommandQueryOf,
} from "../slash-command-autocomplete";

const roster = [
  { slug: "goal", name: "Goal kickstart", description: "Run a goal to done" },
  { slug: "help", name: "Help", description: "List commands" },
  { slug: "workflow-builder", name: "Workflow builder", description: "Automations" },
  { slug: "doc-architect", name: "Doc architect", description: "Docs" },
];

describe("[COMP:app-web/slash-command-autocomplete] query detection", () => {
  it("matches a bare slash and a half-typed word, lower-cased", () => {
    expect(slashCommandQueryOf("/")).toBe("");
    expect(slashCommandQueryOf("/go")).toBe("go");
    expect(slashCommandQueryOf("/GoAl")).toBe("goal");
    expect(slashCommandQueryOf("/workflow-bui")).toBe("workflow-bui");
  });

  it("closes once the command word is settled or the draft is anything else", () => {
    expect(slashCommandQueryOf("/goal register me")).toBeNull();
    expect(slashCommandQueryOf("plain text")).toBeNull();
    expect(slashCommandQueryOf("a /goal inside prose")).toBeNull();
    expect(slashCommandQueryOf("/usr/bin")).toBeNull();
    expect(slashCommandQueryOf("")).toBeNull();
  });
});

describe("[COMP:app-web/slash-command-autocomplete] candidate ranking", () => {
  it("offers everything on a bare slash", () => {
    expect(filterSlashCommands(roster, "").map((s) => s.slug)).toEqual([
      "goal",
      "help",
      "workflow-builder",
      "doc-architect",
    ]);
  });

  it("ranks slug prefix matches before loose name/slug matches", () => {
    const slugs = filterSlashCommands(roster, "wo").map((s) => s.slug);
    expect(slugs[0]).toBe("workflow-builder");
    expect(filterSlashCommands(roster, "builder").map((s) => s.slug)).toEqual([
      "workflow-builder",
    ]);
  });

  it("returns nothing on a miss", () => {
    expect(filterSlashCommands(roster, "zzz")).toEqual([]);
  });

  it("caps the list at eight", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      slug: `skill-${i}`,
      name: `Skill ${i}`,
      description: "",
    }));
    expect(filterSlashCommands(many, "skill")).toHaveLength(8);
  });
});
