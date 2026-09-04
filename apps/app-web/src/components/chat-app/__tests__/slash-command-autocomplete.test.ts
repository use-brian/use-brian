/**
 * Pure logic of the composer's slash-command autocomplete: when the menu may
 * open (the whole draft is a half-typed command word) and how candidates
 * rank. The popup interaction itself mirrors the mention autocomplete and
 * stays under gstack QA.
 * [COMP:app-web/slash-command-autocomplete]
 */

import { describe, expect, it } from "vitest";
import type { SlashCommand } from "@/lib/api/slash-commands";
import {
  activeSlashCommandOf,
  filterSlashCommands,
  slashCommandQueryOf,
} from "../slash-command-autocomplete";

const skill = (slug: string, name: string, description: string): SlashCommand => ({
  slug,
  name,
  description,
  kind: "skill",
  target: { kind: "skill", slug, name, description },
});

const roster: SlashCommand[] = [
  skill("goal", "Goal kickstart", "Run a goal to done"),
  skill("help", "Help", "List commands"),
  skill("workflow-builder", "Workflow builder", "Automations"),
  skill("doc-architect", "Doc architect", "Docs"),
  {
    slug: "workflow_daily_digest",
    name: "Daily Digest",
    description: "Send the digest",
    kind: "workflow",
    target: {
      kind: "workflow",
      workflowId: "workflow-1",
      name: "Daily Digest",
      description: "Send the digest",
    },
  },
];

describe("[COMP:app-web/slash-command-autocomplete] query detection", () => {
  it("matches a bare slash and a half-typed word, lower-cased", () => {
    expect(slashCommandQueryOf("/")).toBe("");
    expect(slashCommandQueryOf("/go")).toBe("go");
    expect(slashCommandQueryOf("/GoAl")).toBe("goal");
    expect(slashCommandQueryOf("/workflow-bui")).toBe("workflow-bui");
    expect(slashCommandQueryOf("/workflow_daily")).toBe("workflow_daily");
  });

  it("closes once the command word is settled or the draft is anything else", () => {
    expect(slashCommandQueryOf("/goal register me")).toBeNull();
    expect(slashCommandQueryOf("plain text")).toBeNull();
    expect(slashCommandQueryOf("a /goal inside prose")).toBeNull();
    expect(slashCommandQueryOf("/usr/bin")).toBeNull();
    expect(slashCommandQueryOf("/2")).toBeNull();
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
      "workflow_daily_digest",
    ]);
  });

  it("ranks slug prefix matches before loose name/slug matches", () => {
    const slugs = filterSlashCommands(roster, "wo").map((s) => s.slug);
    expect(slugs[0]).toBe("workflow-builder");
    expect(filterSlashCommands(roster, "builder").map((s) => s.slug)).toEqual([
      "workflow-builder",
    ]);
    expect(filterSlashCommands(roster, "daily").map((s) => s.slug)).toEqual([
      "workflow_daily_digest",
    ]);
  });

  it("returns nothing on a miss", () => {
    expect(filterSlashCommands(roster, "zzz")).toEqual([]);
  });

  it("keeps the complete matching roster for the scrollable menu", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...skill(`skill-${i}`, `Skill ${i}`, ""),
    }));
    expect(filterSlashCommands(many, "skill")).toHaveLength(12);
  });
});

describe("[COMP:app-web/slash-command-autocomplete] selected command", () => {
  it("recognizes a complete roster-backed prefix and its exact range", () => {
    expect(activeSlashCommandOf("/goal ship it", roster)).toEqual({
      command: roster[0],
      end: 5,
    });
    expect(activeSlashCommandOf("/GOAL", roster)).toEqual({
      command: roster[0],
      end: 5,
    });
    expect(activeSlashCommandOf("/workflow_daily_digest now", roster)).toEqual({
      command: roster[4],
      end: 22,
    });
  });

  it("does not style a partial, unknown, or path-like command", () => {
    expect(activeSlashCommandOf("/go", roster)).toBeNull();
    expect(activeSlashCommandOf("/missing do this", roster)).toBeNull();
    expect(activeSlashCommandOf("/usr/bin", roster)).toBeNull();
  });
});
