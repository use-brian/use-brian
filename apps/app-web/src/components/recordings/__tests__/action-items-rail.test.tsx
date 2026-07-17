// @vitest-environment jsdom
/**
 * [COMP:app-web/recording-chrome] — the action items rail, which is the
 * per-recording EXTRACTION QUEUE.
 *
 * The behaviours here are the ones that decide whether a meeting's captured
 * tasks are reviewable at all: synthesis writes them `source='extracted'` and
 * UNVERIFIED, and the brain inbox excludes extracted rows by design, so if this
 * rail does not distinguish confirmed from unconfirmed, nothing in the product
 * ever does.
 */

import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listRecordingTasks = vi.fn();
vi.mock("@/lib/api/recordings", () => ({
  listRecordingTasks: (...a: unknown[]) => listRecordingTasks(...a),
}));

const verifyBrainRow = vi.fn();
const deleteBrainRow = vi.fn();
const adjustBrainRow = vi.fn();
const fetchBrainRow = vi.fn();
vi.mock("@/lib/api/brain-inbox", () => ({
  verifyBrainRow: (...a: unknown[]) => verifyBrainRow(...a),
  deleteBrainRow: (...a: unknown[]) => deleteBrainRow(...a),
  adjustBrainRow: (...a: unknown[]) => adjustBrainRow(...a),
  fetchBrainRow: (...a: unknown[]) => fetchBrainRow(...a),
}));

vi.mock("@/lib/api/brain", () => ({
  projectInboxRowToBrainRow: (r: unknown) => r,
}));

// The drawer is the brain's own component and pulls a large tree; the rail's
// contract is only that it opens IN PLACE rather than navigating away.
vi.mock("@/components/brain/detail-drawer", () => ({
  BrainDetailDrawer: ({ row }: { row: { id?: string } | null }) =>
    row ? <div data-testid="drawer">{row.id}</div> : null,
}));

const loadWorkspaceRoster = vi.fn();
vi.mock("@/lib/api/workspace-roster", () => ({
  loadWorkspaceRoster: (...a: unknown[]) => loadWorkspaceRoster(...a),
}));

const seekTo = vi.fn();
vi.mock("@/lib/recordings/recording-player-context", () => ({
  useRecordingPlayer: () => ({ seekTo }),
}));

vi.mock("@/lib/i18n/client", () => ({
  useT: () => ({
    recordings: {
      actionItemsLoading: "Loading action items...",
      actionItemsError: "We could not load the action items.",
      actionItemsEmpty: "No action items were captured from this recording.",
      actionItemsSeek: "Jump to",
      actionItemsUnconfirmed: "Not confirmed",
      actionItemsConfirm: "Confirm",
      actionItemsDismiss: "Dismiss",
    },
  }),
}));

import { ActionItemsRail } from "../action-items-rail";

const UNCONFIRMED = {
  id: "t-1",
  title: "Benchmark the index",
  status: "todo" as const,
  assigneeId: null,
  sourceStartMs: 38_000,
  verified: false,
};
const CONFIRMED = {
  id: "t-2",
  title: "Update the pricing doc",
  status: "todo" as const,
  assigneeId: null,
  sourceStartMs: 45_000,
  verified: true,
};

let root: Root | null = null;
let container: HTMLElement | null = null;

async function mount(tasks: unknown[]) {
  listRecordingTasks.mockResolvedValue(tasks);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ActionItemsRail recordingId="rec-1" workspaceId="ws-1" />);
  });
}

function findButton(label: string): HTMLButtonElement | undefined {
  return [...(container?.querySelectorAll("button") ?? [])].find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  loadWorkspaceRoster.mockResolvedValue([]);
  verifyBrainRow.mockResolvedValue({ ok: true });
  deleteBrainRow.mockResolvedValue({ ok: true });
  adjustBrainRow.mockResolvedValue({ ok: true, newId: null });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("[COMP:app-web/recording-chrome] action items rail", () => {
  it("offers Confirm/Dismiss on an unconfirmed item and a checkbox on a confirmed one", async () => {
    await mount([UNCONFIRMED, CONFIRMED]);
    // The whole point of the queue: an extracted row nobody has agreed to must
    // be visibly different from a real task, or the rail is just a task list
    // and the review never happens.
    expect(findButton("Confirm")).toBeTruthy();
    expect(findButton("Dismiss")).toBeTruthy();
    // Exactly one checkbox — the confirmed row's. The unconfirmed row must not
    // offer "close it" before anyone has agreed it is a task.
    expect(container?.querySelectorAll('input[type="checkbox"]').length).toBe(1);
  });

  it("Confirm verifies the row and the item stops being unconfirmed", async () => {
    await mount([UNCONFIRMED]);
    await act(async () => findButton("Confirm")!.click());
    expect(verifyBrainRow).toHaveBeenCalledWith("ws-1", "task", "t-1");
    expect(findButton("Confirm")).toBeFalsy();
    expect(container?.querySelectorAll('input[type="checkbox"]').length).toBe(1);
  });

  it("a failed Confirm reverts rather than showing a state the brain never accepted", async () => {
    verifyBrainRow.mockResolvedValue({ ok: false, error: "nope" });
    await mount([UNCONFIRMED]);
    await act(async () => findButton("Confirm")!.click());
    // Optimistic UI is fine; lying about what the brain stored is not.
    expect(findButton("Confirm")).toBeTruthy();
  });

  it("Dismiss soft-deletes and drops the row from the rail", async () => {
    await mount([UNCONFIRMED]);
    await act(async () => findButton("Dismiss")!.click());
    expect(deleteBrainRow).toHaveBeenCalledWith("ws-1", "task", "t-1");
    expect(container?.textContent).not.toContain("Benchmark the index");
  });

  it("the moment seeks the player — an action item is a pointer into the recording", async () => {
    await mount([CONFIRMED]);
    const stamp = findButton("@ 0:00:45");
    expect(stamp).toBeTruthy();
    await act(async () => stamp!.click());
    expect(seekTo).toHaveBeenCalledWith(45_000);
  });

  it("an item with no cited moment still renders, without a seek link", async () => {
    await mount([{ ...CONFIRMED, sourceStartMs: null }]);
    // A commitment the model failed to timestamp is still a commitment —
    // dropping it would make the rail lie about what the meeting agreed to.
    expect(container?.textContent).toContain("Update the pricing doc");
    expect(findButton("@ 0:00:45")).toBeFalsy();
  });

  it("ticking a confirmed item closes it in the brain", async () => {
    await mount([CONFIRMED]);
    const box = container!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => box.click());
    expect(adjustBrainRow).toHaveBeenCalledWith("ws-1", "task", "t-2", { status: "done" });
  });

  it("clicking the title opens the drawer IN PLACE rather than navigating away", async () => {
    fetchBrainRow.mockResolvedValue({ id: "t-2", verifiedAt: "2026-07-17T00:00:00Z" });
    await mount([CONFIRMED]);
    await act(async () => findButton("Update the pricing doc")!.click());
    expect(fetchBrainRow).toHaveBeenCalledWith("ws-1", "task", "t-2");
    // Routing to /brain would drop the playhead and the brief being read.
    expect(container?.querySelector('[data-testid="drawer"]')).toBeTruthy();
  });

  it("renders an empty state rather than an error when nothing was captured", async () => {
    await mount([]);
    // Ingest-only uploads and blueprints without `capture: ['task']` are both
    // normal — an empty rail is a fact.
    expect(container?.textContent).toContain("No action items were captured");
  });
});
