import { describe, expect, it } from "vitest";
import type { TaskRow } from "../api/tasks";
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
  tagsWithProject,
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

describe("[COMP:app-web/tasks-view] project tag facet", () => {
  it("reads the project off the project: tag namespace", () => {
    expect(taskProject(task({ tags: ["project:launch", "ops"] }))).toBe("launch");
    expect(taskProject(task({ tags: ["ops"] }))).toBeNull();
    expect(taskProject(task({ tags: ["project:"] }))).toBeNull();
  });

  it("rewrites the project tag without touching other tags", () => {
    expect(tagsWithProject(["ops", "project:old"], "new")).toEqual([
      "ops",
      "project:new",
    ]);
    expect(tagsWithProject(["ops", "project:old"], null)).toEqual(["ops"]);
  });

  it("collects distinct sorted project options", () => {
    const rows = [
      task({ tags: ["project:beta"] }),
      task({ tags: ["project:alpha"] }),
      task({ tags: ["project:beta"] }),
      task(),
    ];
    expect(projectOptions(rows)).toEqual(["alpha", "beta"]);
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
      assignee: "none",
      priority: "high",
      project: "launch",
      due: "overdue",
      q: "deck",
      group: "assignee",
      sort: "due",
      view: "board",
      completed: true,
    });
    const decoded = viewStateFromSearch(searchFromViewState(s));
    expect(decoded).toEqual(s);
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
        tags: ["project:launch"],
        due: "2026-07-01T00:00:00Z", // overdue vs NOW
        title: "Ship the pricing deck",
      }),
      task({ title: "Other" }),
    ];
    expect(applyFilters(rows, state({ assignee: "m1" }), NOW)).toHaveLength(1);
    expect(applyFilters(rows, state({ assignee: "none" }), NOW)).toHaveLength(1);
    expect(applyFilters(rows, state({ priority: "high" }), NOW)).toHaveLength(1);
    expect(applyFilters(rows, state({ priority: "none" }), NOW)).toHaveLength(1);
    expect(applyFilters(rows, state({ project: "launch" }), NOW)).toHaveLength(1);
    expect(applyFilters(rows, state({ due: "overdue" }), NOW)).toHaveLength(1);
    expect(applyFilters(rows, state({ q: "pricing" }), NOW)).toHaveLength(1);
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
      task({ tags: ["project:beta"] }),
      task(),
      task({ tags: ["project:beta"] }),
      task({ tags: ["project:alpha"] }),
    ];
    const groups = groupRows(rows, "project", NOW);
    expect(groups.map((g) => g.key)).toEqual(["beta", "alpha", ""]);
  });
});
