import { describe, expect, it } from "vitest";
import { taskIcon, type TaskRow } from "../api/tasks";
import {
  applyFilters,
  DEFAULT_VIEW_STATE,
  dueBucket,
  groupRows,
  matchesQuickFilter,
  projectOptions,
  quickFilterCounts,
  searchFromViewState,
  sortRows,
  taskProject,
  viewStateFromSearch,
  type TasksViewState,
} from "../tasks-view";

const NOW = new Date("2026-07-22T12:00:00Z");

let seq = 0;
function task(over: Partial<TaskRow> = {}): TaskRow {
  seq++;
  return {
    id: `t-${String(seq).padStart(3, "0")}`,
    title: `Task ${seq}`,
    status: "todo",
    assigneeId: null,
    due: null,
    tags: [],
    parentId: null,
    attributes: {},
    updatedAt: "2026-07-21T00:00:00Z",
    ...over,
  };
}

function state(over: Partial<TasksViewState> = {}): TasksViewState {
  return { ...DEFAULT_VIEW_STATE, ...over };
}

describe("[COMP:app-web/task-project-context] stable Project facet", () => {
  it("reads the stable Project id rather than parsing a tag", () => {
    expect(taskProject(task({ projectId: "project-id", tags: ["ops"] }))).toBe("project-id");
    expect(taskProject(task({ tags: ["project:legacy"] }))).toBeNull();
  });

  it("collects distinct sorted project options", () => {
    const rows = [
      task({ projectId: "beta" }),
      task({ projectId: "alpha" }),
      task({ projectId: "beta" }),
      task(),
    ];
    expect(projectOptions(rows)).toEqual(["alpha", "beta"]);
  });
});

describe("[COMP:app-web/tasks-surface] task icon", () => {
  it("reads a valid optional icon and hides absent or malformed values", () => {
    expect(taskIcon(task({ attributes: { icon: "🚀" } }))).toBe("🚀");
    expect(taskIcon(task({ attributes: {} }))).toBeNull();
    expect(taskIcon(task({ attributes: { icon: "" } }))).toBeNull();
    expect(taskIcon(task({ attributes: { icon: "x".repeat(17) } }))).toBeNull();
  });
});

describe("[COMP:app-web/tasks-view] cleanup quick-filters", () => {
  it("stale = open and untouched past the 30-day window", () => {
    const stale = task({ updatedAt: "2026-06-01T00:00:00Z" });
    const fresh = task({ updatedAt: "2026-07-20T00:00:00Z" });
    const staleDone = task({ status: "done", updatedAt: "2026-06-01T00:00:00Z" });
    expect(matchesQuickFilter(stale, "stale", NOW)).toBe(true);
    expect(matchesQuickFilter(fresh, "stale", NOW)).toBe(false);
    // Done rows are never "stale" — they're the doneOpen class instead.
    expect(matchesQuickFilter(staleDone, "stale", NOW)).toBe(false);
  });

  it("doneOpen = done but not archived; unassigned/noDue apply to open rows only", () => {
    expect(matchesQuickFilter(task({ status: "done" }), "doneOpen", NOW)).toBe(true);
    expect(matchesQuickFilter(task({ status: "archived" }), "doneOpen", NOW)).toBe(false);
    expect(matchesQuickFilter(task(), "unassigned", NOW)).toBe(true);
    expect(
      matchesQuickFilter(task({ assigneeId: "m1" }), "unassigned", NOW),
    ).toBe(false);
    expect(
      matchesQuickFilter(task({ status: "done" }), "unassigned", NOW),
    ).toBe(false);
    expect(matchesQuickFilter(task(), "noDue", NOW)).toBe(true);
    expect(
      matchesQuickFilter(task({ due: "2026-08-01T00:00:00Z" }), "noDue", NOW),
    ).toBe(false);
  });

  it("counts agree with the predicates", () => {
    const rows = [
      task({ updatedAt: "2026-05-01T00:00:00Z" }), // stale + unassigned + noDue
      task({ status: "done" }), // doneOpen
      task({ assigneeId: "m1", due: "2026-08-01T00:00:00Z" }), // none
    ];
    const counts = quickFilterCounts(rows, NOW);
    expect(counts.stale).toBe(1);
    expect(counts.doneOpen).toBe(1);
    // The done row is not "open", so it counts toward neither class.
    expect(counts.unassigned).toBe(1);
    expect(counts.noDue).toBe(1);
  });
});

// The URL codec IS the surface's state contract — the filter row, the
// sidebar panel, and the dock card all speak it (tagged for the surface).
describe("[COMP:app-web/tasks-surface] URL codec", () => {
  it("round-trips a view state and omits defaults", () => {
    expect(searchFromViewState(state())).toBe("");
    const s = state({
      quick: "stale",
      assignee: ["none"],
      priority: ["high"],
      project: ["launch"],
      due: ["overdue"],
      q: "deck",
      group: "assignee",
      sort: "due",
      view: "board",
      completed: true,
    });
    const decoded = viewStateFromSearch(searchFromViewState(s));
    expect(decoded).toEqual(s);
  });

  it("round-trips MULTI-value filters (the whole set survives a link)", () => {
    const s = state({
      statuses: ["todo", "in_progress"],
      assignee: ["m1", "m2", "none"],
      priority: ["high", "urgent"],
      project: ["launch", "ops"],
      due: ["overdue", "week"],
    });
    expect(viewStateFromSearch(searchFromViewState(s))).toEqual(s);
  });

  it("comma-joins closed vocabularies + ids, but repeats free text", () => {
    const search = searchFromViewState(
      state({ assignee: ["m1", "m2"], project: ["launch", "ops"] }),
    );
    const params = new URLSearchParams(search);
    expect(params.getAll("assignee")).toEqual(["m1,m2"]);
    expect(params.getAll("project")).toEqual(["launch", "ops"]);
  });

  it("a project name containing a comma stays ONE filter", () => {
    // The reason project can't comma-join: joining would split this name
    // into two filters, and neither would match anything.
    const s = state({ project: ["Q3: launch, phase 2"] });
    expect(viewStateFromSearch(searchFromViewState(s)).project).toEqual([
      "Q3: launch, phase 2",
    ]);
  });

  it("parses both shapes, so pre-multi single-value deep links survive", () => {
    expect(viewStateFromSearch("assignee=m1").assignee).toEqual(["m1"]);
    expect(viewStateFromSearch("assignee=m1,m2").assignee).toEqual(["m1", "m2"]);
    expect(viewStateFromSearch("assignee=m1&assignee=m2").assignee).toEqual([
      "m1",
      "m2",
    ]);
    expect(viewStateFromSearch("status=todo,done").statuses).toEqual([
      "todo",
      "done",
    ]);
    // Duplicates collapse; the pill's lead label must be deterministic.
    expect(viewStateFromSearch("assignee=m1,m1").assignee).toEqual(["m1"]);
  });

  it("seeds the dock card's deep link (?filter=stale)", () => {
    expect(viewStateFromSearch("filter=stale").quick).toBe("stale");
  });

  it("drops unknown values back to defaults", () => {
    const decoded = viewStateFromSearch("filter=bogus&group=bogus&sort=bogus&view=bogus");
    expect(decoded.quick).toBeNull();
    expect(decoded.group).toBe("status");
    expect(decoded.sort).toBe("updated");
    expect(decoded.view).toBe("table");
  });

  it("drops unknown members of a multi-value closed vocabulary", () => {
    expect(viewStateFromSearch("status=todo,bogus,done").statuses).toEqual([
      "todo",
      "done",
    ]);
    expect(viewStateFromSearch("priority=high,bogus,none").priority).toEqual([
      "high",
      "none",
    ]);
    expect(viewStateFromSearch("due=week,bogus").due).toEqual(["week"]);
  });
});

describe("[COMP:app-web/tasks-view] filtering, sorting, grouping", () => {
  it("hides done/archived by default; the completed toggle reveals them", () => {
    const rows = [task(), task({ status: "done" }), task({ status: "archived" })];
    expect(applyFilters(rows, state(), NOW)).toHaveLength(1);
    expect(applyFilters(rows, state({ completed: true }), NOW)).toHaveLength(3);
    // An explicit status filter also opts in.
    expect(
      applyFilters(rows, state({ statuses: ["done"] }), NOW),
    ).toHaveLength(1);
  });

  it("a quick filter picks its own status slice (doneOpen needs done rows)", () => {
    const rows = [task(), task({ status: "done" })];
    const hit = applyFilters(rows, state({ quick: "doneOpen" }), NOW);
    expect(hit).toHaveLength(1);
    expect(hit[0].status).toBe("done");
  });

  it("filters assignee / priority / project / due / needle", () => {
    const rows = [
      task({
        assigneeId: "m1",
        attributes: { priority: "high" },
        projectId: "launch",
        due: "2026-07-01T00:00:00Z", // overdue vs NOW
        title: "Ship the pricing deck",
      }),
      task({ title: "Other" }),
    ];
    expect(applyFilters(rows, state({ assignee: ["m1"] }), NOW)).toHaveLength(1);
    expect(applyFilters(rows, state({ assignee: ["none"] }), NOW)).toHaveLength(1);
    expect(applyFilters(rows, state({ priority: ["high"] }), NOW)).toHaveLength(1);
    expect(applyFilters(rows, state({ priority: ["none"] }), NOW)).toHaveLength(1);
    expect(applyFilters(rows, state({ project: ["launch"] }), NOW)).toHaveLength(1);
    expect(applyFilters(rows, state({ due: ["overdue"] }), NOW)).toHaveLength(1);
    expect(applyFilters(rows, state({ q: "pricing" }), NOW)).toHaveLength(1);
  });

  it("ORs within a property: two assignees show BOTH people's tasks", () => {
    const rows = [
      task({ id: "a", assigneeId: "m1" }),
      task({ id: "b", assigneeId: "m2" }),
      task({ id: "c", assigneeId: "m3" }),
      task({ id: "d", assigneeId: null }),
    ];
    expect(
      applyFilters(rows, state({ assignee: ["m1", "m2"] }), NOW).map((r) => r.id),
    ).toEqual(["a", "b"]);
    // "none" is an ordinary member of the set — unassigned OR Alice.
    expect(
      applyFilters(rows, state({ assignee: ["m1", "none"] }), NOW).map((r) => r.id),
    ).toEqual(["a", "d"]);
  });

  it("ORs within status / priority / project / due too", () => {
    const rows = [
      task({ id: "todo", status: "todo" }),
      task({ id: "prog", status: "in_progress" }),
      task({ id: "block", status: "blocked" }),
    ];
    expect(
      applyFilters(rows, state({ statuses: ["todo", "blocked"] }), NOW).map(
        (r) => r.id,
      ),
    ).toEqual(["todo", "block"]);

    const priced = [
      task({ id: "hi", attributes: { priority: "high" } }),
      task({ id: "ur", attributes: { priority: "urgent" } }),
      task({ id: "lo", attributes: { priority: "low" } }),
    ];
    expect(
      applyFilters(priced, state({ priority: ["high", "urgent"] }), NOW).map(
        (r) => r.id,
      ),
    ).toEqual(["hi", "ur"]);

    const tagged = [
      task({ id: "l", projectId: "launch" }),
      task({ id: "o", projectId: "ops" }),
      task({ id: "x", projectId: "other" }),
    ];
    expect(
      applyFilters(tagged, state({ project: ["launch", "ops"] }), NOW).map(
        (r) => r.id,
      ),
    ).toEqual(["l", "o"]);

    const dated = [
      task({ id: "over", due: "2026-07-01T00:00:00Z" }),
      task({ id: "soon", due: "2026-07-24T00:00:00Z" }),
      task({ id: "far", due: "2026-12-01T00:00:00Z" }),
    ];
    expect(
      applyFilters(dated, state({ due: ["overdue", "week"] }), NOW).map(
        (r) => r.id,
      ),
    ).toEqual(["over", "soon"]);
  });

  it("ANDs across properties (Alice or Bob, AND high priority)", () => {
    const rows = [
      task({ id: "hit", assigneeId: "m1", attributes: { priority: "high" } }),
      task({ id: "wrongPri", assigneeId: "m2", attributes: { priority: "low" } }),
      task({ id: "wrongOwner", assigneeId: "m3", attributes: { priority: "high" } }),
    ];
    expect(
      applyFilters(
        rows,
        state({ assignee: ["m1", "m2"], priority: ["high"] }),
        NOW,
      ).map((r) => r.id),
    ).toEqual(["hit"]);
  });

  it("sorts by due with undated rows last, and by priority rank", () => {
    const a = task({ due: "2026-08-01T00:00:00Z" });
    const b = task({ due: "2026-07-25T00:00:00Z" });
    const c = task();
    expect(sortRows([a, c, b], "due").map((r) => r.id)).toEqual([
      b.id,
      a.id,
      c.id,
    ]);
    const urgent = task({ attributes: { priority: "urgent" } });
    const low = task({ attributes: { priority: "low" } });
    const none = task();
    expect(sortRows([low, none, urgent], "priority").map((r) => r.id)).toEqual([
      urgent.id,
      low.id,
      none.id,
    ]);
  });

  it("groups by status in lifecycle order and buckets due dates", () => {
    const rows = [
      task({ status: "todo" }),
      task({ status: "in_progress" }),
      task({ status: "blocked" }),
    ];
    expect(groupRows(rows, "status", NOW).map((g) => g.key)).toEqual([
      "in_progress",
      "todo",
      "blocked",
    ]);
    expect(dueBucket(task({ due: "2026-07-01T00:00:00Z" }), NOW)).toBe("overdue");
    expect(dueBucket(task({ due: "2026-07-24T00:00:00Z" }), NOW)).toBe("week");
    expect(dueBucket(task({ due: "2026-09-01T00:00:00Z" }), NOW)).toBe("later");
    expect(dueBucket(task(), NOW)).toBe("none");
  });

  it("groups by project with the none-bucket last", () => {
    const rows = [
      task({ projectId: "beta" }),
      task(),
      task({ projectId: "beta" }),
      task({ projectId: "alpha" }),
    ];
    const groups = groupRows(rows, "project", NOW);
    expect(groups.map((g) => g.key)).toEqual(["beta", "alpha", ""]);
  });
});
