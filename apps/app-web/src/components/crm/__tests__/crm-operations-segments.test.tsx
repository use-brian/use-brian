// @vitest-environment jsdom

/** [COMP:app-web/crm-operations] Shared segment builder, preview, and addressable selection. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  archiveCrmSegment: vi.fn(),
  listCrmSegments: vi.fn(),
  previewCrmSegment: vi.fn(),
  saveCrmSegment: vi.fn(),
}));
vi.mock("@/lib/api/crm", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api/crm")>(),
  ...api,
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: vi.fn(async () => true) }));

import { CrmSegmentsPanel } from "../operations/segments-panel";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SEGMENT_ID = "00000000-0000-4000-8000-000000000010";
const segment = {
  id: SEGMENT_ID, segmentKey: "named_examples", name: "Named examples", description: "Current example records",
  entityKind: "person" as const,
  predicate: { type: "group" as const, combinator: "and" as const, items: [
    { type: "rule" as const, family: "base" as const, field: "name", operator: "contains" as const, value: "Example" },
  ] },
  version: 2, archivedAt: null, createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z",
};
const catalog = [{ family: "base" as const, field: "name", label: "Name", operators: ["eq" as const, "contains" as const], valueType: "text" as const }];

let host: HTMLDivElement;
let root: Root;
async function settle() { for (let index = 0; index < 8; index += 1) await act(async () => { await Promise.resolve(); }); }

beforeEach(async () => {
  vi.clearAllMocks();
  api.listCrmSegments.mockResolvedValue({ segments: [segment], catalog });
  api.previewCrmSegment.mockResolvedValue({
    rows: [{ id: "00000000-0000-4000-8000-000000000020", name: "Taylor Example", kind: "person" }],
    count: 1, snapshotIds: ["00000000-0000-4000-8000-000000000020"],
  });
  api.saveCrmSegment.mockResolvedValue({ record: { ...segment, version: 3 }, created: false });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<I18nProvider locale="en" dict={en}><CrmSegmentsPanel workspaceId="workspace-1" selectedId={SEGMENT_ID} onSelect={vi.fn()} /></I18nProvider>));
  await settle();
});

afterEach(() => {
  act(() => root.unmount()); host.remove();
  document.querySelectorAll("[data-base-ui-portal]").forEach((node) => node.remove());
});

describe("[COMP:app-web/crm-operations] CRM segment workspace", () => {
  it("renders a catalog-bound predicate with live count, rows, and stable snapshot ids", () => {
    expect(host.textContent).toContain("Named examples");
    expect(host.textContent).toContain("Base field: Name");
    expect(host.textContent).toContain("1 matching records");
    expect(host.textContent).toContain("Taylor Example");
    expect(api.previewCrmSegment).toHaveBeenCalledWith("workspace-1", SEGMENT_ID);
  });

  it("saves the versioned predicate through the canonical member API", async () => {
    const save = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === en.crmPage.operations.segmentSave);
    await act(async () => save?.click()); await settle();
    expect(api.saveCrmSegment).toHaveBeenCalledWith("workspace-1", expect.objectContaining({
      segmentId: SEGMENT_ID, segmentKey: "named_examples", entityKind: "person",
      expectedVersion: 2,
      predicate: expect.objectContaining({ combinator: "and" }),
    }));
  });
});
