// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSurfaceCache } from "@/lib/surface-cache";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const authFetch = vi.hoisted(() => vi.fn<typeof fetch>());
const confirm = vi.hoisted(() => vi.fn(async () => true));

vi.mock("@/lib/auth-fetch", () => ({ authFetch }));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: confirm }));
vi.mock("@/lib/i18n/client", () => ({
  useT: () => ({ studioPage: { ingestRules: { applicationRecovery: {
    title: "Incomplete brain updates", help: "Help", loading: "Loading", empty: "Empty",
    error: "Error", refresh: "Refresh", retry: "Retry unfinished", retrying: "Retrying",
    cancel: "Cancel", confirmTitle: "Confirm", confirmBody: "Only unfinished writes", older: "Older runs", newer: "Newer runs",
    committed: "Applied", failed: "Failed", held: "Held", rejected: "Rejected", finishedWithHolds: "Finished with held items", ambiguousIdentity: "Ambiguous record match", lastError: "Last error",
    scopeMismatch: "Source sharing restrictions", legacy: "Legacy", states: { complete: "Complete", partial: "Partially applied", blocked: "Blocked", not_started: "Not started" },
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
  counts: { pending: 0, committed: 1, already_applied: 1, held: 1, rejected: 0, failed: 1 },
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
  authFetch.mockReset();
  confirm.mockClear();
  resetSurfaceCache();
});

describe("[COMP:app-web/ingest-application] application recovery", () => {
  it("renders durable counts and confirms a retry through the shared API", async () => {
    const sibling = { ...item, runId: "00000000-0000-4000-8000-000000000006", counts: { ...item.counts, committed: 8 } };
    authFetch.mockResolvedValueOnce(Response.json({ applications: [item, sibling], nextCursor: null }));
    authFetch.mockResolvedValueOnce(Response.json({ ...item, applicationState: "complete", resumable: false,
      items: [{ candidateId: "entity", primitiveKind: "entity", disposition: "held", failureCode: "application_entity_alias_conflict", attemptCount: 1, retryable: false }],
      counts: { ...item.counts, committed: 2, rejected: 2, failed: 0 } }));
    await mount();
    expect(container!.textContent).toContain("Applied: 2")
    expect(container!.textContent).toContain("Last error: write_failed")
    const retry = [...container!.querySelectorAll("button")].find((button) => button.textContent === "Retry unfinished")!;
    await act(async () => { retry.click(); });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Confirm" }));
    expect(authFetch).toHaveBeenCalledWith(expect.stringContaining(`/episodes/${item.episodeId}/retry-application`), expect.objectContaining({
      method: "POST", body: JSON.stringify({ runId: item.runId, expectedPlanHash: item.planHash }),
    }));
    expect(container!.textContent).toContain("Finished with held items");
    expect(container!.textContent).toContain("Ambiguous record match");
    expect(container!.textContent).toContain("Held: 1 · Rejected: 2");
    expect(container!.textContent).toContain("Applied: 3");
    expect(container!.textContent).toContain("Applied: 9");
  });

  it("explains when source sharing restrictions hold an update", async () => {
    const scopedItem = { candidateId: "entity", primitiveKind: "entity", disposition: "held",
      failureCode: "application_entity_scope_mismatch", attemptCount: 1, retryable: false };
    authFetch.mockResolvedValueOnce(Response.json({ applications: [{ ...item, items: [scopedItem] }], nextCursor: null }));
    await mount();
    expect(container!.textContent).toContain("Source sharing restrictions");
    expect(container!.textContent).not.toContain("Ambiguous record match");
  });

  it("keeps persisted results across navigation and reuses the workspace cache", async () => {
    authFetch.mockResolvedValueOnce(Response.json({ applications: [item], nextCursor: null }));
    await mount();
    act(() => root!.unmount());
    root = createRoot(container!);
    await act(async () => { root!.render(<ApplicationRecovery workspaceId="workspace-1" />); });
    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(container!.textContent).toContain("Partially applied");
  });

  it("reaches earlier runs and returns to the cached newer page", async () => {
    authFetch.mockResolvedValueOnce(Response.json({ applications: [item], nextCursor: item.runId }));
    authFetch.mockResolvedValueOnce(Response.json({ applications: [{ ...item, episodeId: "earlier" }], nextCursor: null }));
    await mount();
    const button = (text: string) => [...container!.querySelectorAll("button")].find(b => b.textContent === text)!;
    await act(async () => { button("Older runs").click(); });
    expect(authFetch).toHaveBeenCalledWith(expect.stringContaining(`cursor=${item.runId}`));
    expect(container!.textContent).toContain("earlier");
    await act(async () => { button("Newer runs").click(); });
    expect(container!.textContent).toContain(item.episodeId);
    expect(authFetch).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed retry visible when refreshing the list succeeds", async () => {
    const page = { applications: [item], nextCursor: null };
    authFetch.mockResolvedValueOnce(Response.json(page))
      .mockResolvedValueOnce(Response.json({ error: "forbidden" }, { status: 403 }))
      .mockResolvedValueOnce(Response.json(page));
    await mount();
    const retry = [...container!.querySelectorAll("button")].find(button => button.textContent === "Retry unfinished")!;
    await act(async () => { retry.click(); });
    expect(container!.querySelector('[role="alert"]')?.textContent).toBe("Error");
    expect(container!.textContent).toContain("Applied: 2");
  });
});
