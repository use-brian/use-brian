/**
 * [COMP:app-web/goals-board] Goals SDK (app-web) — the read-only board list.
 * Spec: docs/architecture/features/goals.md.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import { authFetch } from "@/lib/auth-fetch";
import { listGoals, confirmGoal, type GoalRow } from "../goals";

const mockAuthFetch = vi.mocked(authFetch);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

const SAMPLE: GoalRow = {
  id: "g1",
  outcome: "ship it",
  status: "active",
  host: { type: "task", id: "t1" },
  parentGoalId: null,
  recipeId: null,
  blockerReason: null,
  confirmedAt: null,
  hasWorkflow: false,
  createdAt: "2026-06-30T00:00:00.000Z",
  updatedAt: "2026-06-30T00:00:00.000Z",
};

describe("[COMP:app-web/goals-board] goals SDK", () => {
  it("lists goals for a workspace and parses the envelope", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({ goals: [SAMPLE] }));
    const out = await listGoals("ws-1");
    expect(out).toEqual([SAMPLE]);
    const url = mockAuthFetch.mock.calls[0][0] as string;
    expect(url).toContain("/api/goals?");
    expect(url).toContain("workspaceId=ws-1");
  });

  it("threads status / hostType / includeTerminal into the query string", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({ goals: [] }));
    await listGoals("ws-1", { status: "done", hostType: "task", includeTerminal: true });
    const url = mockAuthFetch.mock.calls[0][0] as string;
    expect(url).toContain("status=done");
    expect(url).toContain("hostType=task");
    expect(url).toContain("includeTerminal=true");
  });

  it("omits absent filters from the query string", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({ goals: [] }));
    await listGoals("ws-1");
    const url = mockAuthFetch.mock.calls[0][0] as string;
    expect(url).not.toContain("status=");
    expect(url).not.toContain("hostType=");
    expect(url).not.toContain("includeTerminal=");
  });

  it("returns [] on a non-OK response (board renders its empty state)", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({ error: "nope" }, 500));
    expect(await listGoals("ws-1")).toEqual([]);
  });

  it("returns [] when the envelope carries no goals array", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({}));
    expect(await listGoals("ws-1")).toEqual([]);
  });
});

describe("[COMP:app-web/goals-board] confirmGoal clarity gate (§12)", () => {
  it("surfaces needsClarification (HTTP 200, ok:false) as a non-OK result + question", async () => {
    mockAuthFetch.mockResolvedValueOnce(
      json({ ok: false, needsClarification: true, question: "What does done look like?" }),
    );
    const r = await confirmGoal("g1");
    expect(r.ok).toBe(false);
    expect(r.needsClarification).toBe(true);
    expect(r.question).toBe("What does done look like?");
  });

  it("returns the armed goal on a clear confirm", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({ ok: true, goal: SAMPLE }));
    const r = await confirmGoal("g1", "Close the Acme deal");
    expect(r.ok).toBe(true);
    expect(r.goal).toEqual(SAMPLE);
  });

  it("maps a non-OK HTTP response to an error result", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({ error: "nope" }, 500));
    const r = await confirmGoal("g1");
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});
