import { describe, it, expect } from "vitest";
import {
  TRIGGER_KEY,
  autoLayoutPositions,
  boardExtent,
  canvasEdges,
  connectEdge,
  edgeInsertionCandidate,
  insertStepIntoEdge,
  pruneLayout,
  removeEdge,
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
