/**
 * In-chat goal pursuit — pure logic: where a session goal's inline card
 * anchors in the transcript, when a goal counts as terminal, and how a SENT
 * message resolves as a slash command (roster-backed, mirroring the server
 * parser's whole-message form).
 * [COMP:app-web/goal-pursuit]
 */

import { describe, expect, it } from "vitest";
import type { GoalRow } from "@/lib/api/goals";
import {
  interleaveSessionGoals,
  isGoalPursuitTerminal,
} from "../goal-pursuit";
import {
  isSlashCommandShaped,
  sentSlashCommandOf,
} from "../slash-command-autocomplete";

function goalRow(over: Partial<GoalRow> & Pick<GoalRow, "id" | "createdAt">): GoalRow {
  return {
    outcome: "extract billing images into the spreadsheet",
    status: "active",
    host: null,
    hostTitle: null,
    parentGoalId: null,
    recipeId: null,
    blockerReason: null,
    contextGroupId: null,
    contextProjectId: null,
    confirmedAt: over.createdAt,
    hasWorkflow: true,
    originSessionId: "s1",
    updatedAt: over.createdAt,
    ...over,
  };
}

const msg = (id: string, iso: string) => ({ id, timestamp: new Date(iso) });

describe("[COMP:app-web/goal-pursuit] card placement", () => {
  const messages = [
    msg("m1", "2026-08-29T10:00:00Z"),
    msg("m2", "2026-08-29T10:01:00Z"),
    msg("m3", "2026-08-29T10:05:00Z"),
  ];

  it("anchors after the last message at-or-before the goal's creation", () => {
    const goal = goalRow({ id: "g1", createdAt: "2026-08-29T10:02:00Z" });
    const placement = interleaveSessionGoals(messages, [goal]);
    expect(placement.afterMessage.get("m2")?.map((g) => g.id)).toEqual(["g1"]);
    expect(placement.trailing).toEqual([]);
  });

  it("a goal created in the same second as its arming turn anchors after it", () => {
    const goal = goalRow({ id: "g1", createdAt: "2026-08-29T10:01:00Z" });
    const placement = interleaveSessionGoals(messages, [goal]);
    expect(placement.afterMessage.get("m2")?.map((g) => g.id)).toEqual(["g1"]);
  });

  it("a goal older than every message anchors after the first (truncated history)", () => {
    const goal = goalRow({ id: "g1", createdAt: "2026-08-29T09:00:00Z" });
    const placement = interleaveSessionGoals(messages, [goal]);
    expect(placement.afterMessage.get("m1")?.map((g) => g.id)).toEqual(["g1"]);
  });

  it("a goal newer than every message trails; empty transcripts trail everything", () => {
    const goal = goalRow({ id: "g1", createdAt: "2026-08-29T11:00:00Z" });
    expect(
      interleaveSessionGoals(messages, [goal]).afterMessage.get("m3")?.map((g) => g.id),
    ).toEqual(["g1"]);
    const late = goalRow({ id: "g2", createdAt: "2026-08-29T11:00:00Z" });
    const placement = interleaveSessionGoals([], [late]);
    expect(placement.trailing.map((g) => g.id)).toEqual(["g2"]);
  });

  it("goals sharing an anchor keep creation order", () => {
    const a = goalRow({ id: "gA", createdAt: "2026-08-29T10:03:00Z" });
    const b = goalRow({ id: "gB", createdAt: "2026-08-29T10:02:00Z" });
    const placement = interleaveSessionGoals(messages, [a, b]);
    expect(placement.afterMessage.get("m2")?.map((g) => g.id)).toEqual(["gB", "gA"]);
  });

  it("terminal statuses are done / blocked / abandoned", () => {
    expect(isGoalPursuitTerminal("done")).toBe(true);
    expect(isGoalPursuitTerminal("blocked")).toBe(true);
    expect(isGoalPursuitTerminal("abandoned")).toBe(true);
    expect(isGoalPursuitTerminal("active")).toBe(false);
    expect(isGoalPursuitTerminal("running")).toBe(false);
    expect(isGoalPursuitTerminal(null)).toBe(false);
  });
});

describe("[COMP:app-web/goal-pursuit] sent-command matching", () => {
  const roster = [
    {
      slug: "goal",
      name: "Goal kickstart",
      description: "Run a goal to done",
      kind: "skill" as const,
      target: {
        kind: "skill" as const,
        slug: "goal",
        name: "Goal kickstart",
        description: "Run a goal to done",
      },
    },
    {
      slug: "workflow_daily_digest",
      name: "Daily Digest",
      description: "Send a digest",
      kind: "workflow" as const,
      target: {
        kind: "workflow" as const,
        workflowId: "workflow-1",
        name: "Daily Digest",
        description: "Send a digest",
      },
    },
  ];

  it("resolves a whole-message roster-backed command with args", () => {
    const hit = sentSlashCommandOf("/goal fill the billing sheet", roster);
    expect(hit?.command.slug).toBe("goal");
    expect(hit?.args).toBe("fill the billing sheet");
    expect(sentSlashCommandOf("/GOAL x", roster)?.command.slug).toBe("goal");
    expect(sentSlashCommandOf("  /workflow_daily_digest  ", roster)?.args).toBe("");
  });

  it("an unknown slug, prose, or a path stays an ordinary message", () => {
    expect(sentSlashCommandOf("/nope do it", roster)).toBeNull();
    expect(sentSlashCommandOf("use /goal here", roster)).toBeNull();
    expect(sentSlashCommandOf("/usr/bin", roster)).toBeNull();
    expect(sentSlashCommandOf("/2", roster)).toBeNull();
  });

  it("the syntactic probe matches the same shapes the parser accepts", () => {
    expect(isSlashCommandShaped("/goal something")).toBe(true);
    expect(isSlashCommandShaped("/help")).toBe(true);
    expect(isSlashCommandShaped("/workflow_daily_digest region=apac")).toBe(true);
    expect(isSlashCommandShaped("plain text")).toBe(false);
    expect(isSlashCommandShaped("/usr/bin")).toBe(false);
  });
});
