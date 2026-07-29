// @vitest-environment jsdom
/**
 * [COMP:app-web/brain-entries] — the accumulating read behind the Brain list.
 *
 * The whole point of this hook is that rows ADD UP across pages, so the ways it
 * can break are all "the list is subtly wrong" rather than "the list is
 * missing": a chunk that replaces instead of appends, a filter change that
 * appends the new query's rows onto the old query's list, a late response from
 * an abandoned query landing in the current one, or a duplicate row taking down
 * the render with a repeated React key.
 *
 * `chunkStart` is tested too, because the entrance animation reads it: if it
 * does not track the newest chunk, either nothing animates or the entire list
 * re-animates on every append.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ listBrain: vi.fn() }));
vi.mock("@/lib/api/brain", () => ({ listBrain: api.listBrain }));

import { useBrainEntries } from "@/lib/use-brain-entries";
import type { BrainRow } from "@/lib/api/brain";

const row = (id: string): BrainRow =>
  ({ id, kind: "memories", name: `Row ${id}`, sensitivity: "internal" }) as BrainRow;

const page = (ids: string[], nextCursor: string | null) => ({
  rows: ids.map(row),
  nextCursor,
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let container: HTMLDivElement;
let root: Root;
/** Latest hook state, captured from the probe component. */
let latest: ReturnType<typeof useBrainEntries>;

function Probe({ search }: { search: string }) {
  latest = useBrainEntries({
    workspaceId: "w1",
    primitives: [],
    search,
    viewpointAssistantId: null,
    refreshTick: 0,
    enabled: true,
  });
  return <span>{(latest.rows ?? []).map((r) => r.id).join(",")}</span>;
}

async function render(search = "") {
  await act(async () => {
    root.render(<Probe search={search} />);
    await settle();
  });
}

describe("[COMP:app-web/brain-entries] Chunked Brain entries", () => {
  beforeEach(() => {
    api.listBrain.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("loads the first chunk and reports more when a cursor comes back", async () => {
    api.listBrain.mockResolvedValue(page(["a", "b"], "C2"));
    await render();
    expect(container.textContent).toBe("a,b");
    expect(latest.hasMore).toBe(true);
    expect(latest.loading).toBe(false);
  });

  it("appends the next chunk instead of replacing the list", async () => {
    api.listBrain
      .mockResolvedValueOnce(page(["a", "b"], "C2"))
      .mockResolvedValueOnce(page(["c", "d"], null));
    await render();

    await act(async () => {
      latest.loadMore();
      await settle();
    });
    expect(container.textContent).toBe("a,b,c,d");
    // Cursor exhausted — the sentinel must stop asking.
    expect(latest.hasMore).toBe(false);
  });

  it("sends the cursor from the previous page", async () => {
    api.listBrain
      .mockResolvedValueOnce(page(["a"], "C2"))
      .mockResolvedValueOnce(page(["b"], null));
    await render();
    await act(async () => {
      latest.loadMore();
      await settle();
    });
    expect(api.listBrain.mock.calls[1][0]).toMatchObject({ cursor: "C2" });
  });

  it("marks only the newest chunk via chunkStart", async () => {
    api.listBrain
      .mockResolvedValueOnce(page(["a", "b"], "C2"))
      .mockResolvedValueOnce(page(["c"], null));
    await render();
    expect(latest.chunkStart).toBe(0);

    await act(async () => {
      latest.loadMore();
      await settle();
    });
    // Row index 2 ("c") is the newest chunk; a/b must not re-animate.
    expect(latest.chunkStart).toBe(2);
  });

  it("resets to page one when the query changes", async () => {
    api.listBrain
      .mockResolvedValueOnce(page(["a", "b"], "C2"))
      .mockResolvedValueOnce(page(["z"], null));
    await render("");
    await act(async () => {
      root.render(<Probe search="zebra" />);
      await settle();
    });
    // Not "a,b,z" — a new query is a new list.
    expect(container.textContent).toBe("z");
    expect(api.listBrain.mock.calls[1][0]).toMatchObject({
      search: "zebra",
      cursor: undefined,
    });
  });

  it("drops a response from a query the user has moved off", async () => {
    let releaseStale: (value: unknown) => void = () => {};
    api.listBrain
      // First query hangs...
      .mockImplementationOnce(
        () => new Promise((resolve) => (releaseStale = resolve)),
      )
      // ...the second resolves immediately.
      .mockResolvedValueOnce(page(["fresh"], null));

    await render("");
    await act(async () => {
      root.render(<Probe search="new" />);
      await settle();
    });
    expect(container.textContent).toBe("fresh");

    await act(async () => {
      releaseStale(page(["stale"], null));
      await settle();
    });
    // The abandoned query's rows must never reach the current list.
    expect(container.textContent).toBe("fresh");
  });

  it("dedupes a row repeated across chunks", async () => {
    api.listBrain
      .mockResolvedValueOnce(page(["a", "b"], "C2"))
      .mockResolvedValueOnce(page(["b", "c"], null));
    await render();
    await act(async () => {
      latest.loadMore();
      await settle();
    });
    // A repeated key would be a hard React render bug, not a cosmetic one.
    expect(container.textContent).toBe("a,b,c");
  });

  it("does not fetch again once the cursor is exhausted", async () => {
    api.listBrain.mockResolvedValue(page(["a"], null));
    await render();
    await act(async () => {
      latest.loadMore();
      await settle();
    });
    expect(api.listBrain).toHaveBeenCalledTimes(1);
  });

  it("keeps what is on screen when a chunk fails", async () => {
    api.listBrain
      .mockResolvedValueOnce(page(["a"], "C2"))
      .mockRejectedValueOnce(new Error("network"));
    await render();
    await act(async () => {
      latest.loadMore();
      await settle();
    });
    expect(container.textContent).toBe("a");
    // Paging stops rather than retrying into a broken endpoint.
    expect(latest.hasMore).toBe(false);
  });
});
