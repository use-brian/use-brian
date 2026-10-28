// @vitest-environment jsdom
import React, { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DragEndEvent } from "@dnd-kit/core";
import type { BoardWidget, CalendarWidget, ViewPayload } from "../../../../../../packages/views-renderer/src/types";

// Capture only the library callback boundary. The real context, sensors,
// sortable hooks, widget state and rendered children still run.
const dnd = vi.hoisted(() => ({ onDragEnd: undefined as ((event: DragEndEvent) => void) | undefined }));
const ports = vi.hoisted(() => ({ renderBinding: vi.fn(), patchEntity: vi.fn() }));
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  const react = await import("react");
  return { ...actual, DndContext: (props: ComponentProps<typeof actual.DndContext>) => {
    dnd.onDragEnd = props.onDragEnd;
    return react.createElement(actual.DndContext, props);
  } };
});
// Both the public import and the real host use current source, never old dist.
vi.mock("@use-brian/views-renderer", async () => import("../../../../../../packages/views-renderer/src/index"));
vi.mock("@/lib/api/views", () => ({ renderBinding: ports.renderBinding }));
vi.mock("@/lib/api/entities", () => ({ patchEntity: ports.patchEntity, createEntity: vi.fn(), deleteEntity: vi.fn() }));
vi.mock("@/lib/workspace-context", () => ({ useWorkspaceContext: () => ({ workspaceId: "workspace-reconcile" }) }));
vi.mock("@/lib/i18n/client", async () => {
  const { en } = await import("@/lib/i18n/dictionaries/en");
  return { useT: () => en, format: (s: string, p: Record<string, unknown> = {}) =>
    s.replace(/\{(\w+)\}/g, (_, key: string) => String(p[key] ?? "")) };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/desktop-auth-source", () => ({ isDesktopAuth: () => false }));
// Unrelated shell/peek surfaces are outside these interaction paths.
vi.mock("@/components/tasks/task-record-detail", () => ({ TaskRecordDetail: () => null }));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
vi.mock("@/components/ui/prompt-dialog", () => ({ promptDialog: vi.fn() }));
vi.mock("@/components/ui/kind-picker-dialog", () => ({ kindPickerDialog: vi.fn(), PICKABLE_KINDS: [] }));
vi.mock("../../doc/block-child-page", () => ({ BlockChildPage: () => null }));
vi.mock("../../doc/block-image", () => ({ BlockImage: () => null }));
vi.mock("../../doc/block-file", () => ({ BlockFile: () => null }));
vi.mock("../../doc/block-drawing", () => ({ BlockDrawing: () => null }));
vi.mock("../../doc/drawing-transaction", () => ({ saveDrawing: vi.fn() }));
vi.mock("../../doc/block-bookmark", () => ({ BlockBookmark: () => null }));
vi.mock("../../doc/block-extraction-slot", () => ({ BlockExtractionSlot: () => null }));
vi.mock("../../doc/visual-lightbox", () => ({ ZoomableVisual: ({ children }: { children: ReactNode }) => children }));
vi.mock("../../doc/view-config/view-toolbar", () => ({ ViewToolbar: () => null }));

import { Board } from "../../../../../../packages/views-renderer/src/widgets/Board";
import { Calendar } from "../../../../../../packages/views-renderer/src/widgets/Calendar";
import { ViewRenderer } from "../../../../../../packages/views-renderer/src/render";
import { DataEmbed } from "../../doc/node-views/embed-view";

const NOW = new Date(2026, 4, 15, 12);
const ROW = "row:one|raw";
function board(): BoardWidget {
  return { type: "board", groupBy: "status", columns: [
    { id: "todo", title: "Pending", cards: [{ id: ROW, data: { title: "Original card", due: "2026-05-15" } }] },
    { id: "done", title: "Complete", cards: [] },
  ], cardSchema: { type: "text", text: "{{title}} {{due}}" } };
}
function calendar(): CalendarWidget {
  return { type: "calendar", columns: [{ field: "title", header: "Title" }, { field: "due", header: "Due" }],
    rows: [{ id: ROW, title: "Original task", due: "2026-05-15", otherDate: "2026-05-18" }],
    dateColumnId: "due", rowAction: { id: "open-entity", params: { entity: "tasks" } } };
}
function payload(widget: BoardWidget | CalendarWidget): ViewPayload { return { a2ui: "0.8", root: widget }; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let container: HTMLDivElement;
let root: Root;
async function paint(node: ReactNode) { await act(async () => { root.render(node); }); }
async function settle() { await act(async () => {}); }
function boardColumn(title: string): HTMLElement {
  const label = [...container.querySelectorAll("span")].find((e) => e.textContent === title);
  if (!label?.parentElement?.parentElement) throw new Error(`Missing board column ${title}`);
  return label.parentElement.parentElement;
}
async function move(over: string | null = "done") {
  if (!dnd.onDragEnd) throw new Error("Real Board did not register a drag handler");
  await act(async () => { dnd.onDragEnd!({ active: { id: ROW }, over: over === null ? null : { id: over } } as DragEndEvent); });
}
function chipDay(): string | undefined {
  const chip = [...container.querySelectorAll("[data-calendar-chip]")].find((e) => e.getAttribute("data-calendar-chip") === ROW);
  return chip?.closest("[data-calendar-day]")?.getAttribute("data-calendar-day") ?? undefined;
}
async function drop(day: string, empty = false) {
  const values = new Map<string, string>();
  const transfer = { types: [] as string[], effectAllowed: "none", setData(type: string, value: string) {
    values.set(type, value); if (!this.types.includes(type)) this.types.push(type);
  }, getData(type: string) { return values.get(type) ?? ""; } };
  const chip = container.querySelector("[data-calendar-chip]");
  const cell = container.querySelector(`[data-calendar-day="${day}"]`);
  if (!chip || !cell) throw new Error("Missing real calendar drag source/target");
  await act(async () => {
    if (!empty) {
      const start = new Event("dragstart", { bubbles: true, cancelable: true });
      Object.defineProperty(start, "dataTransfer", { value: transfer }); chip.dispatchEvent(start);
    }
    const over = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(over, "dataTransfer", { value: transfer }); cell.dispatchEvent(over);
    if (!empty) expect(over.defaultPrevented).toBe(true);
    const end = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(end, "dataTransfer", { value: transfer }); cell.dispatchEvent(end);
  });
}
async function click(selector: string) {
  const element = container.querySelector(selector);
  if (!element) throw new Error(`Missing control ${selector}`);
  await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  ports.renderBinding.mockReset(); ports.patchEntity.mockReset(); dnd.onDragEnd = undefined;
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

describe("[COMP:views/board] actual mounted payload reconciliation", () => {
  it("adopts changed card values and column titles with the same IDs", async () => {
    const first = board(); await paint(<Board {...first} />);
    const fresh = board(); fresh.columns[0].title = "Renamed pending";
    fresh.columns[0].cards[0].data = { title: "Refreshed card", due: "2026-05-20" };
    await paint(<Board {...fresh} />);
    expect(container.textContent).toContain("Renamed pending");
    expect(container.textContent).toContain("Refreshed card 2026-05-20");
    expect(container.textContent).not.toContain("Original card");
  });
  it("retains an optimistic move for the same source, then rolls back to fresh same-ID truth", async () => {
    const first = board(); const before = JSON.stringify(first); const onAction = vi.fn();
    await paint(<Board {...first} onAction={onAction} />); await move();
    expect(boardColumn("Complete").textContent).toContain("Original card");
    await paint(<Board {...first} onAction={onAction} />);
    expect(boardColumn("Complete").textContent).toContain("Original card");
    expect(JSON.stringify(first)).toBe(before);
    expect(onAction.mock.calls).toEqual([["move-card", { cardId: ROW, fromCol: "todo", toCol: "done" }]]);
    await paint(<Board {...board()} onAction={onAction} />);
    expect(boardColumn("Pending").textContent).toContain("Original card");
    expect(onAction).toHaveBeenCalledTimes(1);
  });
  it("accepts confirmed server movement and resets on grouping identity changes", async () => {
    const first = board(); await paint(<Board {...first} />); await move();
    const fresh = board(); fresh.columns[1].cards = fresh.columns[0].cards; fresh.columns[0].cards = [];
    fresh.columns[1].cards[0].data.title = "Confirmed card";
    await paint(<Board {...fresh} />);
    expect(boardColumn("Complete").textContent).toContain("Confirmed card");
    await paint(<Board {...first} />); await move();
    await paint(<Board {...first} groupBy="stage" />);
    expect(boardColumn("Pending").textContent).toContain("Original card");
  });
  it("preserves cancel, same-column and missing-target no-ops", async () => {
    const first = board(); const onAction = vi.fn(); await paint(<Board {...first} onAction={onAction} />);
    await move(null); await move("todo"); await move("missing");
    expect(boardColumn("Pending").textContent).toContain("Original card"); expect(onAction).not.toHaveBeenCalled();
  });
});

describe("[COMP:views/calendar] actual native drop and authoritative rows", () => {
  it("rolls back a failed same-ID date after preserving same-payload optimism", async () => {
    const first = calendar(); const before = JSON.stringify(first); const onAction = vi.fn();
    await paint(<Calendar {...first} now={NOW} onAction={onAction} />); await drop("2026-05-16");
    expect(chipDay()).toBe("2026-05-16");
    await paint(<Calendar {...first} now={NOW} onAction={onAction} />);
    expect(chipDay()).toBe("2026-05-16"); expect(JSON.stringify(first)).toBe(before);
    expect(onAction.mock.calls).toEqual([["reschedule", { rowId: ROW, date: "2026-05-16", dateField: "due" }]]);
    await paint(<Calendar {...calendar()} now={NOW} onAction={onAction} />);
    expect(chipDay()).toBe("2026-05-15"); expect(onAction).toHaveBeenCalledTimes(1);
  });
  it("adopts accepted or independently changed canonical dates and titles", async () => {
    const first = calendar(); const onAction = vi.fn(); await paint(<Calendar {...first} now={NOW} onAction={onAction} />); await drop("2026-05-16");
    const accepted = calendar(); accepted.rows[0].due = { type: "date", iso: "2026-05-16", format: "absolute" };
    await paint(<Calendar {...accepted} now={NOW} onAction={onAction} />); expect(chipDay()).toBe("2026-05-16");
    const changed = calendar(); changed.rows[0].due = "2026-05-19"; changed.rows[0].title = "Fresh task";
    await paint(<Calendar {...changed} now={NOW} onAction={onAction} />);
    expect(chipDay()).toBe("2026-05-19"); expect(container.textContent).toContain("Fresh task");
  });
  it("clears the old overlay on date-field change without resetting local view or navigation", async () => {
    const first = calendar(); const onAction = vi.fn(); await paint(<Calendar {...first} now={NOW} onAction={onAction} />); await drop("2026-05-16");
    await paint(<Calendar {...first} dateColumnId="otherDate" now={NOW} onAction={onAction} />);
    expect(chipDay()).toBe("2026-05-18");
    await click('[data-calendar-tab="week"]'); await click('[aria-label="Next"]');
    const label = container.querySelector("[data-calendar-label]")?.textContent;
    await paint(<Calendar {...calendar()} now={NOW} initialView="month" onAction={onAction} />);
    expect(container.querySelector("[data-calendar-view]")?.getAttribute("data-calendar-view")).toBe("week");
    expect(container.querySelector("[data-calendar-label]")?.textContent).toBe(label);
  });
  it("retains same-day/empty-payload no-ops and click action propagation", async () => {
    const onAction = vi.fn(); await paint(<Calendar {...calendar()} now={NOW} onAction={onAction} />);
    await drop("2026-05-15"); await drop("2026-05-16", true); expect(onAction).not.toHaveBeenCalled();
    await click('[data-calendar-chip]'); expect(onAction.mock.calls).toEqual([["open-entity", { entity: "tasks", rowId: ROW }]]);
    onAction.mockClear(); await click('[data-calendar-add="2026-05-16"]');
    expect(onAction.mock.calls).toEqual([["date-add", { date: "2026-05-16" }]]);
    onAction.mockClear(); await click('[data-calendar-day="2026-05-16"]');
    expect(onAction.mock.calls).toEqual([["date-clicked", { date: "2026-05-16" }]]);
  });
});

describe("[COMP:views/render] actual public wrapper payload lifetime", () => {
  it.each([
    ["board", undefined, false], ["board", false, undefined],
    ["calendar", undefined, false], ["calendar", false, undefined],
  ] as const)("retains %s optimism when validation-on changes from %s to %s", async (kind, before, after) => {
    const first = payload(kind === "board" ? board() : calendar()); const onAction = vi.fn();
    await paint(<ViewRenderer payload={first} validated={before} onAction={onAction} />);
    if (kind === "board") await move(); else await drop("2026-05-16");
    await paint(<ViewRenderer payload={first} validated={after} onAction={onAction} />);
    if (kind === "board") expect(boardColumn("Complete").textContent).toContain("Original card");
    else expect(chipDay()).toBe("2026-05-16");
    expect(onAction).toHaveBeenCalledTimes(1);
  });
  it("retains Board optimism on same input and adopts replacement input", async () => {
    const first = payload(board()); const onAction = vi.fn();
    await paint(<ViewRenderer payload={first} onAction={onAction} />); await move();
    await paint(<ViewRenderer payload={first} className="changed-parent" onAction={onAction} />);
    expect(boardColumn("Complete").textContent).toContain("Original card");
    await paint(<ViewRenderer payload={payload(board())} onAction={onAction} />);
    expect(boardColumn("Pending").textContent).toContain("Original card"); expect(onAction).toHaveBeenCalledTimes(1);
  });
  it("retains Calendar optimism on same unvalidated input and adopts fresh same-ID truth", async () => {
    const first = payload(calendar()); const before = vi.fn(); const after = vi.fn();
    await paint(<ViewRenderer payload={first} onAction={before} />); await drop("2026-05-16");
    await paint(<ViewRenderer payload={first} className="fresh-class" onAction={after} />);
    expect(chipDay()).toBe("2026-05-16");
    expect(container.firstElementChild?.className).toBe("fresh-class");
    await drop("2026-05-17"); expect(after).toHaveBeenCalledTimes(1); expect(before).toHaveBeenCalledTimes(1);
    await paint(<ViewRenderer payload={payload(calendar())} onAction={after} />);
    expect(chipDay()).toBe("2026-05-15"); expect(after).toHaveBeenCalledTimes(1);
  });
  it("invalidates validation on input or validation-mode change", async () => {
    const invalid = { a2ui: "0.9", root: { type: "text", text: "Trusted bypass" } };
    await paint(<ViewRenderer payload={invalid} />); expect(container.querySelector('[data-a2ui-error="invalid-payload"]')).not.toBeNull();
    await paint(<ViewRenderer payload={invalid} validated />); expect(container.textContent).toBe("Trusted bypass");
    await paint(<ViewRenderer payload={invalid} validated={false} />); expect(container.querySelector('[data-a2ui-error="invalid-payload"]')).not.toBeNull();
    await paint(<ViewRenderer payload={payload(calendar())} />); expect(chipDay()).toBe("2026-05-15");
  });
});

async function mountHost(widget: BoardWidget | CalendarWidget) {
  const binding = widget.type === "board" ? { entity: "tasks", viewType: "board", groupBy: "status" }
    : { entity: "tasks", viewType: "calendar", dateBy: "due" };
  await paint(<DataEmbed block={{ kind: "data", id: "block-one", binding } as never} binding={binding as never} updateBlock={() => {}} />);
  await settle();
}
describe("[COMP:views/board] [COMP:views/calendar] actual DataEmbed and BlockData write/refetch", () => {
  it.each(["board", "calendar"] as const)("%s refusal waits for authoritative same-ID rollback after one write", async (kind) => {
    const first = kind === "board" ? board() : calendar();
    const write = deferred<{ ok: false; error: string }>(); const refresh = deferred<ViewPayload>();
    ports.renderBinding.mockResolvedValueOnce(payload(first)).mockReturnValueOnce(refresh.promise);
    ports.patchEntity.mockReturnValue(write.promise); await mountHost(first);
    if (kind === "board") { await move(); expect(boardColumn("Complete").textContent).toContain("Original card"); }
    else { await drop("2026-05-16"); expect(chipDay()).toBe("2026-05-16"); }
    expect(ports.patchEntity.mock.calls).toEqual([[{ entity: "tasks", id: ROW, patch: kind === "board" ? { status: "done" } : { due: "2026-05-16" } }]]);
    expect(ports.renderBinding).toHaveBeenCalledTimes(1);
    await act(async () => { write.resolve({ ok: false, error: "Test write refused" }); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Test write refused");
    expect(ports.renderBinding).toHaveBeenCalledTimes(2);
    if (kind === "board") expect(boardColumn("Complete").textContent).toContain("Original card");
    else expect(chipDay()).toBe("2026-05-16");
    await act(async () => { refresh.resolve(payload(kind === "board" ? board() : calendar())); });
    if (kind === "board") expect(boardColumn("Pending").textContent).toContain("Original card");
    else expect(chipDay()).toBe("2026-05-15");
    expect(ports.patchEntity).toHaveBeenCalledTimes(1);
  });
  it("retains Board success without introducing a new refetch", async () => {
    const first = board(); const write = deferred<{ ok: true; row: object }>();
    ports.renderBinding.mockResolvedValue(payload(first)); ports.patchEntity.mockReturnValue(write.promise);
    await mountHost(first); await move(); await act(async () => { write.resolve({ ok: true, row: {} }); });
    expect(boardColumn("Complete").textContent).toContain("Original card");
    expect(ports.patchEntity).toHaveBeenCalledTimes(1); expect(ports.renderBinding).toHaveBeenCalledTimes(1);
  });
  it("refreshes Calendar success with same-ID server truth", async () => {
    const accepted = calendar(); accepted.rows[0].due = "2026-05-16";
    const write = deferred<{ ok: true; row: object }>(); const refresh = deferred<ViewPayload>();
    ports.renderBinding.mockResolvedValueOnce(payload(calendar())).mockReturnValueOnce(refresh.promise);
    ports.patchEntity.mockReturnValue(write.promise); await mountHost(calendar()); await drop("2026-05-16");
    await act(async () => { write.resolve({ ok: true, row: {} }); });
    expect(ports.renderBinding).toHaveBeenCalledTimes(2); expect(chipDay()).toBe("2026-05-16");
    await act(async () => { refresh.resolve(payload(accepted)); }); expect(chipDay()).toBe("2026-05-16");
    expect(ports.patchEntity).toHaveBeenCalledTimes(1);
  });
});
