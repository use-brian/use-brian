// @vitest-environment jsdom
/**
 * [COMP:app-web/recording-chrome] — the "Link a recording" picker (migration
 * 339), mounted ON DEMAND by the doc shell after the page ⋯ menu's
 * "Link a recording" item is picked (no always-visible empty-state button —
 * most doc pages are not recording pages).
 *
 * What matters: it fetches the workspace recordings on mount (lazy relative to
 * a page open — the component only exists once the user asked), a pick links
 * via the SDK and hands the updated page metadata back so the doc shell can
 * mount the chrome, and Cancel dismisses without linking.
 */

import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listRecordings = vi.fn();
vi.mock("@/lib/api/recordings", () => ({
  listRecordings: (...a: unknown[]) => listRecordings(...a),
}));

const setPageLinkedRecording = vi.fn();
vi.mock("@/lib/api/views", () => ({
  setPageLinkedRecording: (...a: unknown[]) => setPageLinkedRecording(...a),
}));

// The picker's contract is only "renders items, calls onValueChange with the
// picked id" — the real SearchableSelect pulls a heavy popover tree.
vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: ({
    items,
    onValueChange,
  }: {
    items: { value: string; label: string }[];
    onValueChange: (v: string) => void;
  }) => (
    <select data-testid="picker" onChange={(e) => onValueChange(e.target.value)}>
      <option value="">--</option>
      {items.map((it) => (
        <option key={it.value} value={it.value}>
          {it.label}
        </option>
      ))}
    </select>
  ),
}));

vi.mock("@/lib/i18n/client", () => ({
  useT: () => ({
    recordings: {
      linkTitle: "Link a recording",
      linkPlaceholder: "Choose a recording",
      linkLoading: "Loading recordings...",
      linkSearchPlaceholder: "Search recordings",
      linkCancel: "Cancel",
      linkError: "We could not load your recordings.",
      panelUntitled: "Untitled recording",
    },
  }),
}));

import { RecordingLinkControl } from "../recording-link-control";

let root: Root | null = null;
let container: HTMLElement | null = null;
let linked: unknown = null;
let dismissed = false;

async function mount() {
  linked = null;
  dismissed = false;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <RecordingLinkControl
        viewId="pg-1"
        workspaceId="ws-1"
        onLinked={(m) => {
          linked = m;
        }}
        onDismiss={() => {
          dismissed = true;
        }}
      />,
    );
  });
}

function click(label: string) {
  const btn = [...(container?.querySelectorAll("button") ?? [])].find((b) =>
    b.textContent?.includes(label),
  ) as HTMLButtonElement | undefined;
  return btn;
}

beforeEach(() => {
  vi.clearAllMocks();
  listRecordings.mockResolvedValue([
    { recordingId: "rec-1", title: "Client call", status: "processed", durationMs: 51_252 },
  ]);
  setPageLinkedRecording.mockResolvedValue({ id: "pg-1", linkedRecordingId: "rec-1" });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("[COMP:app-web/recording-chrome] recording link control", () => {
  it("fetches the workspace recordings on mount (the shell mounts it on demand)", async () => {
    await mount();
    expect(listRecordings).toHaveBeenCalledWith("ws-1", { limit: 100 });
    expect(container?.querySelector('[data-testid="picker"]')).toBeTruthy();
  });

  it("links the picked recording and hands the updated metadata back", async () => {
    await mount();
    const picker = container!.querySelector('[data-testid="picker"]') as HTMLSelectElement;
    await act(async () => {
      picker.value = "rec-1";
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(setPageLinkedRecording).toHaveBeenCalledWith("pg-1", "rec-1");
    // onLinked drives the chrome in — without it the user links and sees nothing.
    expect(linked).toEqual({ id: "pg-1", linkedRecordingId: "rec-1" });
  });

  it("Cancel dismisses without linking", async () => {
    await mount();
    await act(async () => click("Cancel")!.click());
    expect(dismissed).toBe(true);
    expect(setPageLinkedRecording).not.toHaveBeenCalled();
  });
});
