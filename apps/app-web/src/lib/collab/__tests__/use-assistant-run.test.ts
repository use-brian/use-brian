import { describe, expect, it } from "vitest";
import { deriveAssistantRun } from "../use-assistant-run";
import type { AssistantRunState } from "@sidanclaw/doc-model";

const run = (over: Partial<AssistantRunState> = {}): AssistantRunState => ({
  pageId: "p",
  status: "running",
  actor: { id: "u-alice", name: "Alice" },
  channel: "telegram",
  startedAt: 1_000,
  expiresAt: 100_000,
  ...over,
});

describe("[COMP:app-web/assistant-run] deriveAssistantRun", () => {
  it("returns null when no awareness state carries a run", () => {
    const states = new Map([
      [1, { user: { id: "u-bob", name: "Bob" } } as never],
      [2, undefined],
    ]);
    expect(deriveAssistantRun(states, 5_000)).toBeNull();
  });

  it("returns the active run published by the service client", () => {
    const states = new Map<number, { assistantRun?: AssistantRunState | null }>([
      [1, { /* a human, no run field */ }],
      [42, { assistantRun: run() }],
    ]);
    expect(deriveAssistantRun(states, 5_000)?.actor.name).toBe("Alice");
  });

  it("ignores a run whose TTL already lapsed (ghost guard)", () => {
    const states = new Map([[42, { assistantRun: run({ expiresAt: 4_000 }) }]]);
    expect(deriveAssistantRun(states, 5_000)).toBeNull();
  });

  it("ignores a cleared (null) run field", () => {
    const states = new Map([[42, { assistantRun: null }]]);
    expect(deriveAssistantRun(states, 5_000)).toBeNull();
  });

  it("prefers the freshest run when more than one is present", () => {
    const states = new Map([
      [42, { assistantRun: run({ startedAt: 1_000, actor: { id: "a", name: "Old" } }) }],
      [43, { assistantRun: run({ startedAt: 9_000, actor: { id: "b", name: "New" } }) }],
    ]);
    expect(deriveAssistantRun(states, 5_000)?.actor.name).toBe("New");
  });

  it("ignores a non-running status", () => {
    const states = new Map([
      [42, { assistantRun: run({ status: "idle" as never }) }],
    ]);
    expect(deriveAssistantRun(states, 5_000)).toBeNull();
  });
});
