// @vitest-environment jsdom
/** [COMP:app-web/crm-duplicate-decisions] Explicit duplicate decisions. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchCrmDuplicates: vi.fn(),
  fetchCrmSeparations: vi.fn(),
  keepCrmRecordsSeparate: vi.fn(),
  mergeCrmRecords: vi.fn(),
  reviewCrmSeparationAgain: vi.fn(),
  undoCrmMerge: vi.fn(),
}));
const dialogs = vi.hoisted(() => ({ confirmDialog: vi.fn() }));

vi.mock("@/lib/api/crm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/crm")>();
  return { ...actual, ...api };
});
vi.mock("@/components/ui/confirm-dialog", () => ({
  confirmDialog: dialogs.confirmDialog,
}));

import { DuplicatesDialog } from "../crm-actions";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LEFT = "00000000-0000-4000-8000-000000000010";
const RIGHT = "00000000-0000-4000-8000-000000000011";
const separation = {
  id: "00000000-0000-4000-8000-000000000030",
  workspaceId: "workspace-1",
  leftEntityId: LEFT,
  rightEntityId: RIGHT,
  leftName: "Jordan Kim",
  rightName: "Jordan Kim",
  reason: null,
  createdAt: "2026-08-25T00:00:00.000Z",
};
const groups = [{
  kind: "person" as const,
  reason: "name" as const,
  value: "jordan kim",
  records: [
    { id: LEFT, name: "Jordan Kim" },
    { id: RIGHT, name: "Jordan Kim" },
  ],
}];

let host: HTMLDivElement;
let root: Root;

async function settle() {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  api.fetchCrmDuplicates.mockResolvedValueOnce(groups).mockResolvedValue([]);
  api.fetchCrmSeparations.mockResolvedValueOnce([]).mockResolvedValue([separation]);
  api.keepCrmRecordsSeparate.mockResolvedValue({ separation, idempotent: false });
  dialogs.confirmDialog.mockResolvedValue(true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider locale="en" dict={en as unknown as Dictionary}>
        <DuplicatesDialog
          workspaceId="workspace-1"
          open
          onOpenChange={() => {}}
          onMerged={() => {}}
        />
      </I18nProvider>,
    );
  });
  await settle();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.querySelectorAll("[data-base-ui-portal]").forEach((node) => node.remove());
});

describe("[COMP:app-web/crm-duplicate-decisions] duplicate review", () => {
  it("offers Merge and Keep separate for every non-survivor", () => {
    expect(document.body.textContent).toContain("Jordan Kim");
    expect(Array.from(document.body.querySelectorAll("button")).some(
      (button) => button.textContent?.trim() === "Merge",
    )).toBe(true);
    expect(Array.from(document.body.querySelectorAll("button")).some(
      (button) => button.textContent?.trim() === "Keep separate",
    )).toBe(true);
  });

  it("removes a kept pair and exposes reversible Review again state", async () => {
    const keep = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Keep separate",
    );
    expect(keep).toBeTruthy();

    await act(async () => { keep!.click(); });
    await settle();

    expect(api.keepCrmRecordsSeparate).toHaveBeenCalledWith("workspace-1", LEFT, RIGHT);
    expect(document.body.textContent).toContain("Kept separate");
    expect(document.body.textContent).toContain("Kept separate (1)");
    expect(Array.from(document.body.querySelectorAll("button")).some(
      (button) => button.textContent?.trim() === "Review again",
    )).toBe(true);
  });
});
