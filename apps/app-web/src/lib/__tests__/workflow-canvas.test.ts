import { describe, it, expect } from "vitest";
import {
  TRIGGER_KEY,
  autoLayoutPositions,
  boardExtent,
  canvasEdges,
  connectEdge,
  edgeInsertionCandidate,
  insertStepIntoEdge,
  joinFanIn,
  parkedJoinStepIds,
  pruneLayout,
  redundantTriggerEdgeKeys,
  removeEdge,
  removeStep,
  resolvePositions,
  unreachableStepIds,
} from "../workflow-canvas";
import type { WorkflowDefinition, WorkflowStep } from "../api/workflow";

const call = (id: string, extra?: Partial<WorkflowStep>): WorkflowStep =>
  ({
    id,
    type: "assistant_call",
    target: { assistantId: "primary" },
    prompt: `do ${id}`,
    ...extra,
  }) as WorkflowStep;

const def = (
  steps: WorkflowStep[],
  extra?: Partial<WorkflowDefinition>,
): WorkflowDefinition => ({
  startStepId: steps[0].id,
  steps,
  ...extra,
});

describe("[COMP:app-web/workflow-canvas] canvasEdges", () => {
  it("renders trigger, explicit, fall-through and branch edges", () => {
    const d = def([
      call("a", { nextStepId: "b" }),
      call("b"), // falls through to br
      {
        id: "br",
        type: "branch",
        condition: { "==": [1, 1] },
        nextStepIdIfTrue: "x",
        nextStepIdIfFalse: null,
      },
      call("x", { nextStepId: null }),
    ]);
    const edges = canvasEdges(d);
    expect(edges.map((e) => `${e.from}->${e.to}:${e.source}`)).toEqual([
      `${TRIGGER_KEY}->a:trigger`,
      "a->b:next",
      "b->br:fallthrough",
      "br->x:true",
    ]);
  });

  it("renders one edge per fan-out target", () => {
    const d = def([
      call("a", { nextStepId: ["b", "c"] }),
      call("b", { nextStepId: null }),
      call("c", { nextStepId: null }),
    ]);
    const fanOut = canvasEdges(d).filter((e) => e.from === "a");
    expect(fanOut.map((e) => e.to).sort()).toEqual(["b", "c"]);
  });
});

describe("[COMP:app-web/workflow-canvas] connectEdge", () => {
  it("adds a second target as a parallel fan-out array (fall-through made explicit)", () => {
    const d = def([call("a"), call("b", { nextStepId: null }), call("c", { nextStepId: null })]);
    // a currently falls through to b; wiring a → c keeps b and fans out.
    const res = connectEdge(d, { kind: "step", stepId: "a" }, "c");
    expect(res.ok).toBe(true);
    if (res.ok) {
      const a = res.definition.steps[0];
      expect(a.type === "assistant_call" && a.nextStepId).toEqual(["b", "c"]);
    }
  });

  it("adds an entry step from the trigger port (start becomes a fan-out array)", () => {
    const d = def([call("a", { nextStepId: null }), call("b", { nextStepId: null })]);
    const res = connectEdge(d, { kind: "trigger" }, "b");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.definition.startStepId).toEqual(["a", "b"]);
  });

  it("replaces a branch arm (scalar by schema)", () => {
    const d = def([
      {
        id: "br",
        type: "branch",
        condition: { "==": [1, 1] },
        nextStepIdIfTrue: "x",
        nextStepIdIfFalse: null,
      },
      call("x", { nextStepId: null }),
      call("y", { nextStepId: null }),
    ]);
    const res = connectEdge(d, { kind: "step", stepId: "br", port: "true" }, "y");
    expect(res.ok).toBe(true);
    if (res.ok) {
      const br = res.definition.steps[0];
      expect(br.type === "branch" && br.nextStepIdIfTrue).toBe("y");
    }
  });

  it("refuses self, duplicate, cycle and over-width wires", () => {
    const wide = def([
      call("a", { nextStepId: ["b1", "b2", "b3", "b4", "b5"] }),
      call("b1", { nextStepId: null }),
      call("b2", { nextStepId: null }),
      call("b3", { nextStepId: null }),
      call("b4", { nextStepId: null }),
      call("b5", { nextStepId: null }),
      call("b6", { nextStepId: null }),
    ]);
    expect(connectEdge(wide, { kind: "step", stepId: "a" }, "a")).toMatchObject({
      ok: false,
      reason: "self",
    });
    expect(connectEdge(wide, { kind: "step", stepId: "a" }, "b1")).toMatchObject({
      ok: false,
      reason: "duplicate",
    });
    expect(connectEdge(wide, { kind: "step", stepId: "a" }, "b6")).toMatchObject({
      ok: false,
      reason: "width",
    });

    const chain = def([call("a", { nextStepId: "b" }), call("b", { nextStepId: null })]);
    expect(connectEdge(chain, { kind: "step", stepId: "b" }, "a")).toMatchObject({
      ok: false,
      reason: "cycle",
    });
  });
});

describe("[COMP:app-web/workflow-canvas] removeEdge", () => {
  it("narrows a fan-out array (2 → scalar → null)", () => {
    const d = def([
      call("a", { nextStepId: ["b", "c"] }),
      call("b", { nextStepId: null }),
      call("c", { nextStepId: null }),
    ]);
    const edges = canvasEdges(d).filter((e) => e.from === "a");
    const afterOne = removeEdge(d, edges.find((e) => e.to === "b")!);
    const a1 = afterOne.steps[0];
    expect(a1.type === "assistant_call" && a1.nextStepId).toBe("c");

    const afterBoth = removeEdge(
      afterOne,
      canvasEdges(afterOne).find((e) => e.from === "a")!,
    );
    const a2 = afterBoth.steps[0];
    expect(a2.type === "assistant_call" && a2.nextStepId).toBeNull();
  });

  it("pins an explicit null when removing the fall-through edge", () => {
    const d = def([call("a"), call("b", { nextStepId: null })]);
    const edge = canvasEdges(d).find((e) => e.source === "fallthrough")!;
    const after = removeEdge(d, edge);
    const a = after.steps[0];
    expect(a.type === "assistant_call" && a.nextStepId).toBeNull();
  });

  it("nulls a branch arm and never removes the trigger edge", () => {
    const d = def([
      {
        id: "br",
        type: "branch",
        condition: { "==": [1, 1] },
        nextStepIdIfTrue: "x",
        nextStepIdIfFalse: null,
      },
      call("x", { nextStepId: null }),
    ]);
    const branchEdge = canvasEdges(d).find((e) => e.source === "true")!;
    const after = removeEdge(d, branchEdge);
    const br = after.steps[0];
    expect(br.type === "branch" && br.nextStepIdIfTrue).toBeNull();

    const triggerEdge = canvasEdges(d).find((e) => e.source === "trigger")!;
    expect(removeEdge(d, triggerEdge)).toEqual(d);
  });
});

describe("[COMP:app-web/workflow-canvas] trigger fan-out (array startStepId)", () => {
  it("renders one trigger edge per entry step", () => {
    const d = def(
      [call("b", { nextStepId: null }), call("c", { nextStepId: null })],
      { startStepId: ["b", "c"] },
    );
    const triggerEdges = canvasEdges(d).filter((e) => e.source === "trigger");
    expect(triggerEdges.map((e) => e.to).sort()).toEqual(["b", "c"]);
  });

  it("the trigger port ADDS an entry step (scalar → array), refusing dupes and width", () => {
    const d = def([
      call("a", { nextStepId: null }),
      call("b", { nextStepId: null }),
    ]);
    const res = connectEdge(d, { kind: "trigger" }, "b");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.definition.startStepId).toEqual(["a", "b"]);

    expect(connectEdge(d, { kind: "trigger" }, "a")).toMatchObject({
      ok: false,
      reason: "duplicate",
    });

    const ids = ["s1", "s2", "s3", "s4", "s5", "s6"];
    const wide = def(
      ids.map((id) => call(id, { nextStepId: null })),
      { startStepId: ids.slice(0, 5) },
    );
    expect(connectEdge(wide, { kind: "trigger" }, "s6")).toMatchObject({
      ok: false,
      reason: "width",
    });
  });

  it("removes a trigger edge only while another remains (narrows to scalar)", () => {
    const d = def(
      [call("b", { nextStepId: null }), call("c", { nextStepId: null })],
      { startStepId: ["b", "c"] },
    );
    const edge = canvasEdges(d).find(
      (e) => e.source === "trigger" && e.to === "c",
    )!;
    const after = removeEdge(d, edge);
    expect(after.startStepId).toBe("b");

    const lastEdge = canvasEdges(after).find((e) => e.source === "trigger")!;
    expect(removeEdge(after, lastEdge)).toEqual(after);
  });

  it("dropping a step on one trigger edge swaps that entry; other seats stay", () => {
    const d = def(
      [
        call("b", { nextStepId: null }),
        call("c", { nextStepId: null }),
        call("x", { nextStepId: null }),
      ],
      { startStepId: ["b", "c"] },
    );
    const edge = canvasEdges(d).find(
      (e) => e.source === "trigger" && e.to === "c",
    )!;
    const res = insertStepIntoEdge(d, "x", edge);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.definition.startStepId).toEqual(["b", "x"]);
      const x = res.definition.steps.find((s) => s.id === "x")!;
      expect(x.type === "assistant_call" && x.nextStepId).toBe("c");
    }
  });

  it("multi-entry starts seed reachability and share the first layout column", () => {
    const d = def(
      [
        call("b", { nextStepId: null }),
        call("c", { nextStepId: null }),
        call("orphan", { nextStepId: null }),
      ],
      { startStepId: ["b", "c"] },
    );
    expect(unreachableStepIds(d)).toEqual(new Set(["orphan"]));
    const pos = autoLayoutPositions(d);
    expect(pos.b.x).toBe(pos.c.x);
    expect(pos[TRIGGER_KEY].x).toBeLessThan(pos.b.x);
  });
});

describe("[COMP:app-web/workflow-canvas] insertStepIntoEdge", () => {
  const next = (d: WorkflowDefinition, id: string) => {
    const s = d.steps.find((x) => x.id === id)!;
    return s.type === "branch" ? undefined : s.nextStepId;
  };

  it("splices a step out of its old seat and into the dropped edge (reorder)", () => {
    const d = def([
      call("a", { nextStepId: "b" }),
      call("b", { nextStepId: "c" }),
      call("c", { nextStepId: null }),
    ]);
    const edge = canvasEdges(d).find((e) => e.from === "a" && e.to === "b")!;
    const res = insertStepIntoEdge(d, "c", edge);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(next(res.definition, "a")).toBe("c");
      expect(next(res.definition, "c")).toBe("b");
      expect(next(res.definition, "b")).toBeNull();
      expect(res.definition.startStepId).toBe("a");
    }
  });

  it("makes the step the start when dropped on the trigger edge (fall-through chain)", () => {
    const d = def([call("a"), call("b"), call("c")]);
    const edge = canvasEdges(d).find((e) => e.source === "trigger")!;
    const res = insertStepIntoEdge(d, "c", edge);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.definition.startStepId).toBe("c");
      expect(next(res.definition, "c")).toBe("a");
      // b's fall-through pointed at c — bypassed to c's (empty) successors.
      expect(next(res.definition, "b")).toBeNull();
      // a's fall-through (→ b) is untouched, so it stays implicit.
      expect(next(res.definition, "a")).toBeUndefined();
    }
  });

  it("moves the start to the step's successor when the start step is dragged away", () => {
    const d = def([
      call("a", { nextStepId: "b" }),
      call("b", { nextStepId: "c" }),
      call("c", { nextStepId: null }),
    ]);
    const edge = canvasEdges(d).find((e) => e.from === "b" && e.to === "c")!;
    const res = insertStepIntoEdge(d, "a", edge);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.definition.startStepId).toBe("b");
      expect(next(res.definition, "b")).toBe("a");
      expect(next(res.definition, "a")).toBe("c");
    }
  });

  it("bypasses a branch arm that pointed at the moved step", () => {
    const d = def([
      {
        id: "br",
        type: "branch",
        condition: { "==": [1, 1] },
        nextStepIdIfTrue: "x",
        nextStepIdIfFalse: null,
      },
      call("x", { nextStepId: "y" }),
      call("y", { nextStepId: null }),
    ]);
    const edge = canvasEdges(d).find((e) => e.source === "trigger")!;
    const res = insertStepIntoEdge(d, "x", edge);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.definition.startStepId).toBe("x");
      expect(next(res.definition, "x")).toBe("br");
      const br = res.definition.steps.find((s) => s.id === "br")!;
      expect(br.type === "branch" && br.nextStepIdIfTrue).toBe("y");
    }
  });

  it("refuses branch nodes, adjacent edges, and splices past the width cap", () => {
    const d = def([
      call("a", { nextStepId: "b" }),
      call("b", { nextStepId: null }),
      {
        id: "br",
        type: "branch",
        condition: { "==": [1, 1] },
        nextStepIdIfTrue: null,
        nextStepIdIfFalse: null,
      },
    ]);
    const ab = canvasEdges(d).find((e) => e.from === "a" && e.to === "b")!;
    expect(insertStepIntoEdge(d, "b", ab)).toMatchObject({
      ok: false,
      reason: "adjacent",
    });
    expect(insertStepIntoEdge(d, "br", ab)).toMatchObject({
      ok: false,
      reason: "branch",
    });

    // Bypassing s widens a to 6 targets — refused whole.
    const wide = def([
      call("a", { nextStepId: ["s", "b2", "b3", "b4", "b5"] }),
      call("s", { nextStepId: ["c1", "c2"] }),
      call("b2", { nextStepId: "z" }),
      call("b3", { nextStepId: null }),
      call("b4", { nextStepId: null }),
      call("b5", { nextStepId: null }),
      call("c1", { nextStepId: null }),
      call("c2", { nextStepId: null }),
      call("z", { nextStepId: null }),
    ]);
    const b2z = canvasEdges(wide).find((e) => e.from === "b2" && e.to === "z")!;
    expect(insertStepIntoEdge(wide, "s", b2z)).toMatchObject({
      ok: false,
      reason: "width",
    });
  });
});

describe("[COMP:app-web/workflow-canvas] edgeInsertionCandidate", () => {
  const d = def([
    call("a", { nextStepId: "b" }),
    call("b", { nextStepId: null }),
    call("c", { nextStepId: null }),
  ]);
  const positions = {
    [TRIGGER_KEY]: { x: 0, y: 300 },
    a: { x: 0, y: 0 },
    b: { x: 400, y: 0 },
    c: { x: 0, y: 500 },
  };

  it("finds the wire whose curve passes near the dragged node's center", () => {
    // a→b runs from (210, 42) to (400, 42); its midpoint sits near x≈305.
    const hit = edgeInsertionCandidate(d, positions, "c", 305, 42);
    expect(hit?.from).toBe("a");
    expect(hit?.to).toBe("b");
    expect(edgeInsertionCandidate(d, positions, "c", 305, 200)).toBeNull();
  });

  it("never offers adjacent wires, and trigger/branch nodes have no candidates", () => {
    expect(edgeInsertionCandidate(d, positions, "b", 305, 42)).toBeNull();
    expect(edgeInsertionCandidate(d, positions, TRIGGER_KEY, 305, 42)).toBeNull();

    const withBranch = def([
      call("a", { nextStepId: "b" }),
      call("b", { nextStepId: null }),
      {
        id: "br",
        type: "branch",
        condition: { "==": [1, 1] },
        nextStepIdIfTrue: null,
        nextStepIdIfFalse: null,
      },
    ]);
    expect(
      edgeInsertionCandidate(withBranch, positions, "br", 305, 42),
    ).toBeNull();
  });
});

describe("[COMP:app-web/workflow-canvas] join legibility", () => {
  // The asked-about shape: start = [c, a] with a → c. Step c has two
  // inbound wires; the trigger wire into it is redundant.
  const fanInDef = def(
    [call("c", { nextStepId: null }), call("a", { nextStepId: "c" })],
    { startStepId: ["c", "a"] },
  );

  it("joinFanIn counts inbound wires (trigger, explicit, fall-through)", () => {
    expect(joinFanIn(fanInDef).get("c")).toBe(2);
    expect(joinFanIn(fanInDef).get("a")).toBe(1);

    const chain = def([call("x"), call("y", { nextStepId: null })]);
    expect(joinFanIn(chain).get("x")).toBe(1); // trigger wire
    expect(joinFanIn(chain).get("y")).toBe(1); // fall-through wire
  });

  it("redundantTriggerEdgeKeys flags an entry step covered by another entry's path", () => {
    expect(redundantTriggerEdgeKeys(fanInDef)).toEqual(new Set(["trigger->c"]));

    const independent = def(
      [call("b", { nextStepId: null }), call("c", { nextStepId: null })],
      { startStepId: ["b", "c"] },
    );
    expect(redundantTriggerEdgeKeys(independent).size).toBe(0);
  });

  it("parkedJoinStepIds badges a join with one settled and one pending inbound path", () => {
    // Run just started: trigger wire settled, a still pending → c parked.
    expect(parkedJoinStepIds(fanInDef, {})).toEqual(new Set(["c"]));
    expect(parkedJoinStepIds(fanInDef, { a: "running" })).toEqual(
      new Set(["c"]),
    );
    // a done and c running: nothing parked any more.
    expect(
      parkedJoinStepIds(fanInDef, { a: "completed", c: "running" }).size,
    ).toBe(0);

    // Diamond: the join badges only once a sibling has settled.
    const diamond = def([
      call("s", { nextStepId: ["b", "c"] }),
      call("b", { nextStepId: "j" }),
      call("c", { nextStepId: "j" }),
      call("j", { nextStepId: null }),
    ]);
    expect(parkedJoinStepIds(diamond, { s: "running" }).size).toBe(0);
    expect(
      parkedJoinStepIds(diamond, {
        s: "completed",
        b: "completed",
        c: "running",
      }),
    ).toEqual(new Set(["j"]));
  });
});

describe("[COMP:app-web/workflow-canvas] unreachableStepIds", () => {
  it("flags orphans even when their dead wires point INTO the live path", () => {
    // The reported shape: start=c, c→b→j, and orphan a fanning into c and j.
    const d = def([
      call("c", { nextStepId: "b" }),
      call("b", { nextStepId: "j" }),
      call("j", { nextStepId: null }),
      call("a", { nextStepId: ["c", "j"] }),
      call("island", { nextStepId: null }),
    ]);
    expect(unreachableStepIds(d)).toEqual(new Set(["a", "island"]));
  });

  it("counts fall-through and branch arms as reachable paths", () => {
    const d = def([
      {
        id: "br",
        type: "branch",
        condition: { "==": [1, 1] },
        nextStepIdIfTrue: "x",
        nextStepIdIfFalse: null,
      },
      call("x"), // falls through to y
      call("y", { nextStepId: null }),
    ]);
    expect(unreachableStepIds(d).size).toBe(0);
  });

  it("marks every step dead when startStepId dangles", () => {
    const d = def([call("a", { nextStepId: null })], { startStepId: "ghost" });
    expect(unreachableStepIds(d)).toEqual(new Set(["a"]));
  });
});

describe("[COMP:app-web/workflow-canvas] layout", () => {
  it("auto-lays-out by DAG column with the trigger at column 0", () => {
    const d = def([
      call("a", { nextStepId: ["b", "c"] }),
      call("b", { nextStepId: "j" }),
      call("c", { nextStepId: "j" }),
      call("j", { nextStepId: null }),
    ]);
    const pos = autoLayoutPositions(d);
    expect(pos[TRIGGER_KEY].x).toBeLessThan(pos.a.x);
    expect(pos.a.x).toBeLessThan(pos.b.x);
    expect(pos.b.x).toBe(pos.c.x); // same column
    expect(pos.b.y).not.toBe(pos.c.y); // stacked rows
    expect(pos.j.x).toBeGreaterThan(pos.b.x);
  });

  it("persisted layout entries win over auto seats; unknown keys are ignored", () => {
    const d = def([call("a", { nextStepId: null })], {
      layout: { a: { x: 500, y: 300 }, ghost: { x: 1, y: 1 } },
    });
    const pos = resolvePositions(d);
    expect(pos.a).toEqual({ x: 500, y: 300 });
    expect(pos).not.toHaveProperty("ghost");
    expect(pos[TRIGGER_KEY]).toBeDefined();

    const extent = boardExtent(pos);
    expect(extent.width).toBeGreaterThan(500);
    expect(extent.height).toBeGreaterThan(300);
  });

  it("pruneLayout drops entries for removed steps but keeps the trigger", () => {
    const d = def([call("a", { nextStepId: null })], {
      layout: {
        a: { x: 1, y: 2 },
        gone: { x: 3, y: 4 },
        [TRIGGER_KEY]: { x: 5, y: 6 },
      },
    });
    const pruned = pruneLayout(d);
    expect(pruned.layout).toEqual({
      a: { x: 1, y: 2 },
      [TRIGGER_KEY]: { x: 5, y: 6 },
    });
  });
});

/**
 * Walks every field that can hold a step id and asserts none points at a
 * step that no longer exists. This mirrors the core schema's dangling-
 * reference refusal (`schemas.ts` superRefine), which is the check that
 * actually fails Save — app-web cannot import `@use-brian/core`, so the
 * invariant is re-stated here rather than borrowed.
 */
const expectNoDanglingRefs = (d: WorkflowDefinition) => {
  const known = new Set(d.steps.map((s) => s.id));
  const starts = Array.isArray(d.startStepId) ? d.startStepId : [d.startStepId];
  for (const s of starts) expect(known).toContain(s);
  for (const step of d.steps) {
    if (step.type === "branch") {
      for (const arm of [step.nextStepIdIfTrue, step.nextStepIdIfFalse]) {
        if (arm != null) expect(known).toContain(arm);
      }
      continue;
    }
    const next = step.nextStepId;
    if (Array.isArray(next)) for (const id of next) expect(known).toContain(id);
    else if (next != null) expect(known).toContain(next);
    if (step.type === "assistant_call") {
      if (step.page && "fromStep" in step.page) {
        expect(known).toContain(step.page.fromStep);
      }
      const thread = (step.deliver as { thread?: { fromStep?: string } } | undefined)
        ?.thread;
      if (thread?.fromStep) expect(known).toContain(thread.fromStep);
    }
  }
  for (const key of Object.keys(d.layout ?? {})) {
    if (key !== TRIGGER_KEY) expect(known).toContain(key);
  }
};

/** `nextStepId` of a non-branch step, with the union narrowed. */
const nextIdOf = (d: WorkflowDefinition, id: string) => {
  const step = d.steps.find((x) => x.id === id);
  if (!step) throw new Error(`no step ${id}`);
  if (step.type === "branch") throw new Error(`${id} is a branch`);
  return step.nextStepId;
};

describe("[COMP:app-web/workflow-canvas] removeStep", () => {
  it("bridges a middle step's predecessor to its successor", () => {
    const d = def([
      call("a", { nextStepId: "b" }),
      call("b", { nextStepId: "c" }),
      call("c", { nextStepId: null }),
    ]);
    const r = removeStep(d, "b");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.definition.steps.map((s) => s.id)).toEqual(["a", "c"]);
    expect(nextIdOf(r.definition, "a")).toBe("c");
    expectNoDanglingRefs(r.definition);
  });

  it("makes an implicit fall-through predecessor explicit", () => {
    // `a` has no nextStepId — it falls through by array order. Removing `b`
    // shifts the array, so the edge must be pinned explicitly or `a` would
    // silently fall through to `c` only by accident of index.
    const d = def([call("a"), call("b"), call("c", { nextStepId: null })]);
    const r = removeStep(d, "b");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(nextIdOf(r.definition, "a")).toBe("c");
    expectNoDanglingRefs(r.definition);
  });

  it("narrows a fan-out array and collapses a single survivor to a scalar", () => {
    const d = def([
      call("a", { nextStepId: ["b", "c"] }),
      call("b", { nextStepId: null }),
      call("c", { nextStepId: null }),
    ]);
    const r = removeStep(d, "c");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(nextIdOf(r.definition, "a")).toBe("b");
    expectNoDanglingRefs(r.definition);
  });

  it("bridges a fan-out entry to that entry's own successors", () => {
    const d = def([
      call("a", { nextStepId: ["b", "c"] }),
      call("b", { nextStepId: "d" }),
      call("c", { nextStepId: null }),
      call("d", { nextStepId: null }),
    ]);
    const r = removeStep(d, "b");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(nextIdOf(r.definition, "a")).toEqual(["d", "c"]);
    expectNoDanglingRefs(r.definition);
  });

  it("pins nextStepId null when the removed step was terminal", () => {
    const d = def([call("a", { nextStepId: "b" }), call("b", { nextStepId: null })]);
    const r = removeStep(d, "b");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(nextIdOf(r.definition, "a")).toBeNull();
    expectNoDanglingRefs(r.definition);
  });

  it("repoints a branch arm at the removed step's successor", () => {
    const d = def([
      {
        id: "br",
        type: "branch",
        condition: { "==": [1, 1] },
        nextStepIdIfTrue: "b",
        nextStepIdIfFalse: "c",
      },
      call("b", { nextStepId: "d" }),
      call("c", { nextStepId: null }),
      call("d", { nextStepId: null }),
    ]);
    const r = removeStep(d, "b");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const br = r.definition.steps[0];
    expect(br.type).toBe("branch");
    if (br.type !== "branch") return;
    expect(br.nextStepIdIfTrue).toBe("d");
    expect(br.nextStepIdIfFalse).toBe("c");
    expectNoDanglingRefs(r.definition);
  });

  it("nulls a branch arm when the removed step had no successor", () => {
    const d = def([
      {
        id: "br",
        type: "branch",
        condition: { "==": [1, 1] },
        nextStepIdIfTrue: "b",
        nextStepIdIfFalse: null,
      },
      call("b", { nextStepId: null }),
      call("c", { nextStepId: null }),
    ]);
    const r = removeStep(d, "b");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const br = r.definition.steps[0];
    if (br.type !== "branch") throw new Error("expected branch");
    expect(br.nextStepIdIfTrue).toBeNull();
    expectNoDanglingRefs(r.definition);
  });

  it("hands a removed start step's seat to its successors", () => {
    const d = def([call("a", { nextStepId: "b" }), call("b", { nextStepId: null })]);
    const r = removeStep(d, "a");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.definition.startStepId).toBe("b");
    expectNoDanglingRefs(r.definition);
  });

  it("keeps sibling trigger fan-out entries when one entry is removed", () => {
    const d = def(
      [
        call("a", { nextStepId: null }),
        call("b", { nextStepId: null }),
        call("c", { nextStepId: null }),
      ],
      { startStepId: ["a", "b", "c"] },
    );
    const r = removeStep(d, "b");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.definition.startStepId).toEqual(["a", "c"]);
    expectNoDanglingRefs(r.definition);
  });

  it("falls back to the first survivor when the sole entry had no successor", () => {
    const d = def(
      [call("a", { nextStepId: null }), call("b", { nextStepId: null })],
      { startStepId: "a" },
    );
    const r = removeStep(d, "a");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.definition.startStepId).toBe("b");
    expectNoDanglingRefs(r.definition);
  });

  it("clears a page.fromStep anchor pointing at the removed step", () => {
    const d = def([
      call("a", { nextStepId: "b", page: { create: true, title: "Report" } }),
      call("b", { nextStepId: null, page: { fromStep: "a" } }),
      call("c", { nextStepId: null }),
    ]);
    const r = removeStep(d, "a");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = r.definition.steps.find((s) => s.id === "b");
    if (b?.type !== "assistant_call") throw new Error("expected assistant_call");
    expect(b.page).toBeUndefined();
    expectNoDanglingRefs(r.definition);
  });

  it("clears a deliver.thread.fromStep reference pointing at the removed step", () => {
    // `thread` is not in the app-web type (the builder cannot author it) but a
    // chat-authored workflow round-trips through this editor carrying it.
    const d = def([
      call("a", { nextStepId: "b" }),
      call("b", {
        nextStepId: null,
        deliver: {
          channelType: "slack",
          channelId: "C1",
          thread: { fromStep: "a" },
        },
      } as Partial<WorkflowStep>),
      call("c", { nextStepId: null }),
    ]);
    const r = removeStep(d, "a");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = r.definition.steps.find((s) => s.id === "b");
    if (b?.type !== "assistant_call") throw new Error("expected assistant_call");
    expect(b.deliver).toEqual({ channelType: "slack", channelId: "C1" });
    expectNoDanglingRefs(r.definition);
  });

  it("prunes the removed step's layout entry and keeps the rest", () => {
    const d = def(
      [
        call("a", { nextStepId: "b" }),
        call("b", { nextStepId: "c" }),
        call("c", { nextStepId: null }),
      ],
      {
        layout: {
          [TRIGGER_KEY]: { x: 0, y: 0 },
          a: { x: 1, y: 1 },
          b: { x: 2, y: 2 },
          c: { x: 3, y: 3 },
        },
      },
    );
    const r = removeStep(d, "b");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.definition.layout).toEqual({
      [TRIGGER_KEY]: { x: 0, y: 0 },
      a: { x: 1, y: 1 },
      c: { x: 3, y: 3 },
    });
    expectNoDanglingRefs(r.definition);
  });

  it("refuses the only remaining step", () => {
    const d = def([call("a", { nextStepId: null })]);
    expect(removeStep(d, "a")).toEqual({ ok: false, reason: "last" });
  });

  it("refuses a bridge that would widen a predecessor past the fan-out cap", () => {
    // `a` already fans out to 4 targets; `b` fans out to 2. Bridging past `b`
    // would leave `a` with 5 + 1 = 6 targets, over MAX_FAN_OUT_WIDTH.
    const d = def([
      call("a", { nextStepId: ["b", "w", "x", "y", "z"] }),
      call("b", { nextStepId: ["p", "q"] }),
      call("w", { nextStepId: null }),
      call("x", { nextStepId: null }),
      call("y", { nextStepId: null }),
      call("z", { nextStepId: null }),
      call("p", { nextStepId: null }),
      call("q", { nextStepId: null }),
    ]);
    expect(removeStep(d, "b")).toEqual({ ok: false, reason: "width" });
  });

  it("never introduces a cycle when bridging a join", () => {
    // Diamond: a fans to b and c, both rejoin at d. Removing b must not make
    // any step reach itself.
    const d = def([
      call("a", { nextStepId: ["b", "c"] }),
      call("b", { nextStepId: "d" }),
      call("c", { nextStepId: "d" }),
      call("d", { nextStepId: null }),
    ]);
    const r = removeStep(d, "b");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectNoDanglingRefs(r.definition);
    // Cycle detection tracks the current PATH, not every visited node — a
    // diamond legitimately re-converges on `d` from two branches.
    const walk = (id: string, path: string[]) => {
      if (path.includes(id)) throw new Error(`cycle through ${id}`);
      const s = r.definition.steps.find((x) => x.id === id);
      if (!s || s.type === "branch") return;
      const next = s.nextStepId;
      for (const n of Array.isArray(next) ? next : next ? [next] : []) {
        walk(n, [...path, id]);
      }
    };
    for (const step of r.definition.steps) {
      expect(() => walk(step.id, [])).not.toThrow();
    }
  });
});
