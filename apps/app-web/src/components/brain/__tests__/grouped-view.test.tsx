// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { BrainRow } from "@/lib/api/brain";

const workspace = vi.hoisted(() => ({ activeId: "workspace-a" }));
vi.mock("@/contexts/workspace-context", () => ({ useWorkspaces: () => workspace }));
import { BrainGroupedView } from "../grouped-view";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const onSelect = vi.fn();
const person: BrainRow = { kind: "person", id: "shared:id", name: "Ada" };
const company: BrainRow = { kind: "company", id: "shared:id", name: "Acme" };
const task: BrainRow = { kind: "tasks", id: "done", name: "Finished", status: "done" };
const fallback: BrainRow = { kind: "file_segment", id: "excerpt", name: "Excerpt" };
function render(props: Partial<ComponentProps<typeof BrainGroupedView>> = {}) {
  act(() => root.render(<I18nProvider locale="en" dict={en}>
    <BrainGroupedView rows={[person, company]} graph={null} onSelect={onSelect} {...props} />
  </I18nProvider>));
}
function box(label: string) {
  const result = [...container.querySelectorAll<HTMLElement>('[role="checkbox"]')]
    .find((node) => node.getAttribute("aria-label") === label);
  if (!result) throw new Error(`Missing checkbox: ${label}`);
  return result;
}
function click(node: HTMLElement) { act(() => node.click()); }
function button(text: string) {
  const result = [...container.querySelectorAll<HTMLButtonElement>('button:not([role="checkbox"])')]
    .find((node) => node.textContent?.includes(text));
  if (!result) throw new Error(`Missing button: ${text}`);
  return result;
}
const all = () => box("Select all loaded rows");
const count = () => container.querySelector('[role="status"]')?.textContent;

beforeEach(() => {
  workspace.activeId = "workspace-a";
  onSelect.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe("[COMP:app-web/brain-grouped-view] List multi-selection", () => {
  it("keeps checkbox selection separate from row opening and distinguishes kind:id", () => {
    render();
    click(box("Select Ada"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(count()).toBe("1 selected");
    expect(all().getAttribute("aria-checked")).toBe("mixed");
    expect(box("Select Acme").getAttribute("aria-checked")).toBe("false");
    expect(box("Select Ada").closest("label")?.parentElement?.className).toContain("bg-primary/10");
    expect(container.querySelector('button button')).toBeNull();
    click(button("Ada"));
    expect(onSelect).toHaveBeenCalledWith(person);
    expect(count()).toBe("1 selected");
    click(box("Select Acme"));
    expect(count()).toBe("2 selected");
    expect(all().getAttribute("aria-checked")).toBe("true");
    click(box("Select Ada"));
    expect(count()).toBe("1 selected");
    click(button("Clear selection"));
    expect(count()).toBe("0 selected");
  });

  it("supports keyboard selection without opening the row", () => {
    render();
    const checkbox = box("Select Ada");
    act(() => {
      checkbox.focus();
      checkbox.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true }));
      checkbox.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true }));
    });
    expect(document.activeElement).toBe(checkbox);
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    expect(count()).toBe("1 selected");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("selects only loaded supported rows, does not auto-select appended pages, and toggles all off", () => {
    const unknown = { kind: "future", id: "new-kind", name: "Future" } as unknown as BrainRow;
    render({ rows: [person, fallback, unknown], completedTasks: [task] });
    expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(2);
    click(all());
    expect(count()).toBe("1 selected");
    render({ rows: [person, company, fallback, unknown], completedTasks: [task] });
    expect(count()).toBe("1 selected");
    expect(all().getAttribute("aria-checked")).toBe("mixed");
    click(all());
    expect(count()).toBe("2 selected");
    click(all());
    expect(count()).toBe("0 selected");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("includes shown completed tasks, preserves opening, and permanently prunes when hidden", () => {
    render({ completedTasks: [task], showCompletedTasks: true });
    click(all());
    expect(count()).toBe("3 selected");
    click(button("Finished"));
    expect(onSelect).toHaveBeenCalledWith(task);
    render({ completedTasks: [task], showCompletedTasks: false });
    expect(count()).toBe("2 selected");
    render({ completedTasks: [task], showCompletedTasks: true });
    expect(box("Select Finished").getAttribute("aria-checked")).toBe("false");
    expect(count()).toBe("2 selected");
  });

  it("prunes removed/filtered rows without resurrecting them and resets across workspaces", () => {
    render();
    click(all());
    render({ rows: [company] });
    expect(count()).toBe("1 selected");
    render();
    expect(box("Select Ada").getAttribute("aria-checked")).toBe("false");
    workspace.activeId = "workspace-b";
    render();
    expect(count()).toBe("0 selected");
    workspace.activeId = "workspace-a";
    render();
    expect(count()).toBe("0 selected");
    click(all());
    render({ rows: [] });
    expect(count()).toBe("0 selected");
    expect(all().getAttribute("aria-disabled") === "true" || all().hasAttribute("disabled")).toBe(true);
    expect(button("Clear selection").disabled).toBe(true);
  });

  it("supports a completed-only list and disables select-all for fallback-only content", () => {
    render({ rows: [], completedTasks: [task], showCompletedTasks: true });
    click(all());
    expect(count()).toBe("1 selected");
    render({ rows: [fallback] });
    expect(count()).toBe("0 selected");
    click(all());
    expect(count()).toBe("0 selected");
  });
});
