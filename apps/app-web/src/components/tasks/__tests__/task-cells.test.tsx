// @vitest-environment jsdom

/**
 * [COMP:app-web/tasks-surface] Due-cell quick picker.
 *
 * The due cell's resting step is the four dates a task actually gets given
 * (today / tomorrow / in 3 days / in 7 days), so the common case is one tap
 * and the calendar is a deliberate second step. What must hold: the quick
 * rows commit a LOCAL calendar day (never the UTC prefix, which is the
 * previous day east of UTC), "Pick a date" reveals the month grid without
 * committing anything, and a picked grid day commits that day.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { AssigneeCell, DueCell } from "@/components/tasks/task-cells";

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

/** Local `YYYY-MM-DD` for `days` from today — the value the cell must commit. */
function expectedDay(days: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Every button in the document (the popover portals outside `container`). */
function buttons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll("button"));
}

function byText(text: string): HTMLButtonElement | undefined {
  return buttons().find((b) => b.textContent?.trim().startsWith(text));
}

function click(el: Element | undefined) {
  if (!el) throw new Error("element not found");
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Flush the commit promise's `finally` (the busy-flag reset) inside act. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function render(
  value: string | null,
  onCommit: (next: string | null) => Promise<{ ok: boolean }>,
) {
  act(() => {
    root.render(
      <I18nProvider locale="en" dict={en}>
        <DueCell value={value} onCommit={onCommit} />
      </I18nProvider>,
    );
  });
  // The trigger is the only button until the popover opens.
  click(buttons()[0]);
}

describe("[COMP:app-web/tasks-surface] Due cell quick picker", () => {
  it("offers today / tomorrow / +3 / +7 and commits the local day", async () => {
    const onCommit = vi.fn().mockResolvedValue({ ok: true });
    render(null, onCommit);

    expect(byText(en.tasksPage.dueToday)).toBeTruthy();
    expect(byText(en.tasksPage.dueTomorrow)).toBeTruthy();
    expect(byText("In 3 days")).toBeTruthy();
    expect(byText("In 7 days")).toBeTruthy();

    click(byText("In 3 days"));
    await flush();
    expect(onCommit).toHaveBeenCalledWith(expectedDay(3));
  });

  it("reveals the calendar without committing, then commits a picked day", async () => {
    const onCommit = vi.fn().mockResolvedValue({ ok: true });
    render(null, onCommit);

    click(byText(en.tasksPage.duePickDate));
    expect(onCommit).not.toHaveBeenCalled();

    // The month grid is up: the current month's label and its day numerals.
    const monthLabel = new Intl.DateTimeFormat(undefined, {
      month: "long",
      year: "numeric",
    }).format(new Date());
    expect(document.body.textContent).toContain(monthLabel);

    // Today's numeral inside the grid commits today.
    const todayIso = expectedDay(0);
    const dayNumeral = String(new Date().getDate());
    // Exclude the dimmed spill cells: a neighbouring month can carry the same
    // numeral, and clicking one would commit the wrong month.
    const cell = buttons().find(
      (b) =>
        b.textContent?.trim() === dayNumeral &&
        b.className.includes("tabular-nums") &&
        !b.className.includes("text-muted-foreground/40"),
    );
    click(cell);
    await flush();
    expect(onCommit).toHaveBeenCalledWith(todayIso);
  });

  it("clears an existing due date", async () => {
    const onCommit = vi.fn().mockResolvedValue({ ok: true });
    render(new Date().toISOString(), onCommit);

    click(byText(en.tasksPage.dueClear));
    await flush();
    expect(onCommit).toHaveBeenCalledWith(null);
  });
});


describe("[COMP:app-web/tasks-surface] assignee directory", () => {
  it("does not label a saved assignment unassigned when the member cannot resolve", () => {
    act(() => root.render(<I18nProvider locale="en" dict={en}><AssigneeCell assigneeId="member-a" roster={null} onCommit={vi.fn()} /></I18nProvider>));
    expect(container.textContent).toContain(en.tasksPage.memberUnavailable);
    expect(container.textContent).not.toContain(en.tasksPage.unassignedOption);
    expect(container.querySelector('button')!.disabled).toBe(true);
  });

  it("populates the open picker after recovery and commits the member ID", async () => {
    const onCommit = vi.fn().mockResolvedValue({ok:true});
    const draw = (roster: null | {id:string; userId:string; userName:string; email:string; avatarUrl:null; role:string}[]) => {
      act(() => root.render(<I18nProvider locale="en" dict={en}><AssigneeCell assigneeId={null} roster={roster} onCommit={onCommit} /></I18nProvider>));
    };
    draw(null);
    expect(container.querySelector('button')!.disabled).toBe(true);
    draw([{id:'member-a',userId:'user-a',userName:'Ari Example',email:'ari@example.com',avatarUrl:null,role:'member'}]);
    click(container.querySelector('button')!);
    await flush();
    click(buttons().find(button => button.textContent?.includes('Ari Example')));
    await flush();
    expect(onCommit).toHaveBeenCalledWith('member-a');
  });
});
