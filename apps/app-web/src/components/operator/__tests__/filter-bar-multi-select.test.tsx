// @vitest-environment jsdom
/**
 * [COMP:app-web/operator-filter-bar] Multi-select semantics.
 *
 * The static render contract lives in `filter-bar.test.tsx`; this file owns
 * the gesture, because "picking a second assignee REPLACED the first" is
 * precisely the bug multi-select fixes and no static render can catch it.
 * `onSet` must always receive the complete next set.
 *
 * Base UI's popover is mocked to render its content inline — this test is
 * about the checklist's toggle math, not about positioning or portals (the
 * shared primitive owns its own interaction tests).
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/i18n/client", () => ({
  useT: () => ({
    filterBar: {
      filter: "Filter",
      clearFilter: "Clear filter",
      view: "View",
      more: "+{count}",
    },
  }),
}));

vi.mock("@/components/ui/popover", async () => {
  const React = await import("react");
  return {
    Popover: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    PopoverTrigger: ({
      children,
      ...props
    }: {
      children: React.ReactNode;
    }) => React.createElement("button", { type: "button", ...props }, children),
    PopoverContent: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", { "data-popover": "" }, children),
  };
});

import { FilterBar } from "../filter-bar";

const DEFS = [
  {
    key: "assignee",
    label: "Assignee",
    options: [
      { value: "none", label: "Unassigned" },
      { value: "m1", label: "Alice" },
      { value: "m2", label: "Bob" },
    ],
  },
  { key: "status", label: "Status", options: [{ value: "todo", label: "Todo" }] },
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(active: Record<string, string[]>, onSet: (k: string, v: string[]) => void) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  render(active, onSet);
}

function render(
  active: Record<string, string[]>,
  onSet: (k: string, v: string[]) => void,
) {
  act(() => {
    root!.render(
      <FilterBar
        defs={DEFS}
        active={active}
        onSet={onSet}
        search=""
        onSearch={() => {}}
        searchPlaceholder="Search"
      />,
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

/** The popovers in DOM order: applied pills first, then the funnel. */
function popovers(): HTMLElement[] {
  return [...container!.querySelectorAll<HTMLElement>("[data-popover]")];
}

function optionRows(scope: HTMLElement): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')];
}

describe("[COMP:app-web/operator-filter-bar] multi-select", () => {
  it("ticking a second value ADDS it — the set grows, never swaps", () => {
    const onSet = vi.fn();
    mount({ assignee: ["m1"] }, onSet);

    const rows = optionRows(popovers()[0]);
    expect(rows.map((r) => r.textContent)).toEqual(["Unassigned", "Alice", "Bob"]);
    expect(rows.map((r) => r.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
    ]);

    act(() => rows[2].click());
    expect(onSet).toHaveBeenCalledWith("assignee", ["m1", "m2"]);
  });

  it("unticking removes just that value; the last one clears the property", () => {
    const onSet = vi.fn();
    mount({ assignee: ["m1", "m2"] }, onSet);

    act(() => optionRows(popovers()[0])[1].click()); // untick Alice
    expect(onSet).toHaveBeenCalledWith("assignee", ["m2"]);

    onSet.mockClear();
    render({ assignee: ["m2"] }, onSet);
    act(() => optionRows(popovers()[0])[2].click()); // untick Bob, the last
    expect(onSet).toHaveBeenCalledWith("assignee", []);
  });

  it("the sentinel is an ordinary member: unassigned OR Alice", () => {
    const onSet = vi.fn();
    mount({ assignee: ["m1"] }, onSet);
    act(() => optionRows(popovers()[0])[0].click());
    expect(onSet).toHaveBeenCalledWith("assignee", ["m1", "none"]);
  });

  it("the pill's clear button drops the whole set at once", () => {
    const onSet = vi.fn();
    mount({ assignee: ["m1", "m2"] }, onSet);
    const clear = container!.querySelector<HTMLElement>(
      '[aria-label="Clear filter: Assignee"]',
    );
    act(() => clear!.click());
    expect(onSet).toHaveBeenCalledWith("assignee", []);
  });

  it("the funnel keeps listing an applied property, with its count", () => {
    // Dropping it the moment its first value lands would unmount the popover
    // mid-selection — the second value could never be picked there.
    mount({ assignee: ["m1", "m2"] }, vi.fn());
    const funnel = popovers()[popovers().length - 1];
    const properties = [...funnel.querySelectorAll("button")].map(
      (b) => b.textContent,
    );
    expect(properties).toEqual(["Assignee2", "Status"]);
  });

  it("the funnel adds to the existing set, not over it", () => {
    const onSet = vi.fn();
    mount({}, onSet);

    // Property step → value step.
    const funnel = popovers()[0];
    act(() => [...funnel.querySelectorAll("button")][0].click());
    act(() => optionRows(popovers()[0])[1].click());
    expect(onSet).toHaveBeenCalledWith("assignee", ["m1"]);

    // The surface echoes the new state back; the value step is still open.
    onSet.mockClear();
    render({ assignee: ["m1"] }, onSet);
    act(() => optionRows(popovers()[1])[2].click());
    expect(onSet).toHaveBeenCalledWith("assignee", ["m1", "m2"]);
  });
});
