import { describe, it, expect } from "vitest";
import {
  TRIGGER_KEY,
  autoLayoutPositions,
  boardExtent,
  canvasEdges,
  connectEdge,
  pruneLayout,
  removeEdge,
  resolvePositions,
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

  it("re-targets startStepId from the trigger port", () => {
    const d = def([call("a", { nextStepId: null }), call("b", { nextStepId: null })]);
    const res = connectEdge(d, { kind: "trigger" }, "b");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.definition.startStepId).toBe("b");
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
