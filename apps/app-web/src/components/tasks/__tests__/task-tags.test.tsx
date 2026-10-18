// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { TaskTags } from "../task-tags";
import { TaskBoard } from "../task-board";
import { isTaskRowList } from "@/lib/api/tasks";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
function render(children: React.ReactNode) {
  act(() => root.render(<I18nProvider locale="en" dict={en}>{children}</I18nProvider>));
}
const labels = () => [...container.querySelectorAll('ul[aria-label="Tags"] li')]
  .map(item => item.textContent);

describe("[COMP:app-web/task-tags] saved task classification", () => {
  it("renders every saved label, including long and non-Latin tags", () => {
    const tags = ["Operations", "Needs review", "週次確認", "Follow-up", "A".repeat(160)];
    render(<TaskTags tags={tags} />);
    expect(labels()).toEqual(tags);
  });

  it("adds no empty tag placeholder", () => {
    render(<TaskTags tags={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("refuses cached task shapes without a valid saved tag array", () => {
    const cached = { id: "task-example", title: "Review the proposal", status: "todo", attributes: {} };
    expect(isTaskRowList([cached])).toBe(false);
    expect(isTaskRowList([{ ...cached, tags: null }])).toBe(false);
    expect(isTaskRowList([{ ...cached, tags: ["Operations", 1] }])).toBe(false);
    expect(isTaskRowList([{ ...cached, tags: [] }])).toBe(true);
  });

  it("shows tags on board cards while the member directory is unavailable", () => {
    render(<TaskBoard
      rows={[{
        id: "task-example", title: "Review the proposal", status: "todo",
        assigneeId: null, due: null, tags: ["Operations", "Needs review"],
        parentId: null, attributes: {}, updatedAt: "2026-10-01T00:00:00.000Z",
      }]}
      roster={null} projects={[]} showCompleted={false}
      onStatusDrop={vi.fn()} onOpenRecord={vi.fn()}
    />);
    expect(labels()).toEqual(["Operations", "Needs review"]);
  });
});
