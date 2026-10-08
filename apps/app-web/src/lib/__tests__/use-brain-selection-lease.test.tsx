// @vitest-environment jsdom
/**
 * [COMP:app-web/brain-deep-link] Content lease for the open Brain drawer
 * (perceived-performance.md, "Content lease for protected lists").
 *
 * Pinned: an open row is re-confirmed every 15 seconds; a denial closes the
 * drawer at once; a transient failure does not, but a row unconfirmed for 30
 * seconds closes; kinds map through the canonical inbox primitive.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ confirmBrainRowAccess: vi.fn() }));
vi.mock("@/lib/api/brain-inbox", () => ({ confirmBrainRowAccess: api.confirmBrainRowAccess }));

import { useBrainSelectionLease } from "@/lib/use-brain-selection-lease";
import type { BrainRow } from "@/lib/api/brain";

const ROW = { id: "task-1", kind: "tasks", name: "Fictional protected task", sensitivity: "internal" } as BrainRow;
let root: Root;
let container: HTMLDivElement;
let select: ReturnType<typeof vi.fn>;

function Probe({ row }: { row: BrainRow | null }) {
  useBrainSelectionLease("workspace-1", row, select as unknown as (row: BrainRow | null) => void);
  return null;
}

const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };
async function advance(ms: number) {
  await act(async () => { vi.advanceTimersByTime(ms); await flush(); });
}

describe("[COMP:app-web/brain-deep-link] Open drawer lease", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    api.confirmBrainRowAccess.mockReset();
    select = vi.fn();
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it("keeps a confirmed row open and asks the canonical primitive", async () => {
    api.confirmBrainRowAccess.mockResolvedValue(true);
    await act(async () => { root.render(<Probe row={ROW} />); });
    for (let step = 0; step < 4; step += 1) await advance(15_000);
    expect(select).not.toHaveBeenCalled();
    expect(api.confirmBrainRowAccess).toHaveBeenCalledWith("workspace-1", "task", "task-1");
  });

  it("closes the drawer on a denial", async () => {
    api.confirmBrainRowAccess.mockResolvedValue(false);
    await act(async () => { root.render(<Probe row={ROW} />); });
    await advance(15_000);
    expect(select).toHaveBeenCalledWith(null);
  });

  it("closes a row left unconfirmed for 30 seconds, not before", async () => {
    api.confirmBrainRowAccess.mockRejectedValue(new TypeError("network down"));
    await act(async () => { root.render(<Probe row={ROW} />); });
    await advance(29_000);
    expect(select).not.toHaveBeenCalled();
    await advance(2_000);
    expect(select).toHaveBeenCalledWith(null);
  });
});
