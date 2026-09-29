// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSurfaceCache } from "@/lib/surface-cache";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ list: vi.fn(), retry: vi.fn() }));
const confirm = vi.hoisted(() => vi.fn(async () => true));

vi.mock("@/lib/api/ingest", () => ({
  listIngestApplications: api.list,
  retryIngestApplication: api.retry,
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: confirm }));
vi.mock("@/lib/i18n/client", () => ({
  useT: () => ({ studioPage: { ingestRules: { applicationRecovery: {
    title: "Incomplete brain updates", help: "Help", loading: "Loading", empty: "Empty",
    error: "Error", refresh: "Refresh", retry: "Retry unfinished", retrying: "Retrying",
    cancel: "Cancel", confirmTitle: "Confirm", confirmBody: "Only unfinished writes",
    committed: "Applied", failed: "Failed", held: "Held", lastError: "Last error",
    legacy: "Legacy", states: { complete: "Complete", partial: "Partially applied", blocked: "Blocked", not_started: "Not started" },
  } } } }),
}));

import { ApplicationRecovery } from "../application-recovery";

const item = {
  status: "tracked" as const,
  runId: "00000000-0000-4000-8000-000000000005",
  episodeId: "00000000-0000-4000-8000-000000000004",
  planHash: "a".repeat(64),
  extractionState: "succeeded" as const,
  applicationState: "partial" as const,
  errorCode: "write_failed",
  counts: { pending: 0, committed: 2, alreadyApplied: 0, held: 1, rejected: 0, failed: 1 },
  resumable: true,
  items: [],
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<ApplicationRecovery workspaceId="workspace-1" />); });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
  resetSurfaceCache();
});

describe("[COMP:app-web/ingest-application] application recovery", () => {
  it("renders durable counts and confirms a retry through the shared API", async () => {
    api.list.mockResolvedValue([item]);
    api.retry.mockResolvedValue({ ...item, applicationState: "complete", resumable: false,
      counts: { ...item.counts, committed: 3, failed: 0 } });
    await mount();
    expect(container!.textContent).toContain("Applied: 2")
    expect(container!.textContent).toContain("Last error: write_failed")
    const retry = [...container!.querySelectorAll("button")].find((button) => button.textContent === "Retry unfinished")!;
    await act(async () => { retry.click(); });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Confirm" }));
    expect(api.retry).toHaveBeenCalledWith({
      episodeId: item.episodeId, runId: item.runId, expectedPlanHash: item.planHash,
    });
    expect(container!.textContent).toContain("Complete");
    expect(container!.textContent).toContain("Applied: 3");
  });

  it("keeps persisted results across navigation and reuses the workspace cache", async () => {
    api.list.mockResolvedValue([item]);
    await mount();
    act(() => root!.unmount());
    root = createRoot(container!);
    await act(async () => { root!.render(<ApplicationRecovery workspaceId="workspace-1" />); });
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(container!.textContent).toContain("Partially applied");
  });
});
