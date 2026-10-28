// @vitest-environment jsdom
/**
 * [COMP:app-web/recordings-board] The recordings board paints from the
 * surface cache (instant-navigation contract N1); its in-flight poll is a
 * `refresh()` on the key, not a private row copy.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { ja } from "@/lib/i18n/dictionaries/ja";
import { zh } from "@/lib/i18n/dictionaries/zh";
import { zhCN } from "@/lib/i18n/dictionaries/zh-cn";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { RecordingSummary } from "@/lib/api/recordings";
import {
  loadSurfaceCache,
  markSurfaceCacheStale,
  resetSurfaceCache,
} from "@/lib/surface-cache";
import { recordingsCacheKey } from "@/lib/surface-prefetch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaces: () => ({ activeId: "w1", workspaces: [], active: null }),
}));
vi.mock("@/lib/user", () => ({
  getUserInfo: () => ({ id: "u1", name: "n", email: "e" }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
const api = vi.hoisted(() => ({ listRecordings: vi.fn() }));
vi.mock("@/lib/api/recordings", () => ({
  listRecordings: (...args: unknown[]) => api.listRecordings(...args),
}));

import { RecordingsPanel } from "../recordings-panel";

const dict = en as unknown as Dictionary;

const rec = (id: string, title: string): RecordingSummary => ({
  recordingId: id,
  title,
  fileName: `${id}.webm`,
  kind: "meeting",
  status: "processed",
  mime: "audio/webm",
  durationMs: 60_000,
  bytes: 1024,
  occurredAt: new Date().toISOString(),
  truncated: false,
  lastError: null,
  hasTranscript: true,
  transcriptFileId: "f1",
  participants: [],
});

const pending = () => new Promise<never>(() => {});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(locale: "en" | "ja" | "zh" | "zh-CN" = "en", dictionary = dict) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <I18nProvider locale={locale} dict={dictionary}>
        <RecordingsPanel />
      </I18nProvider>,
    );
    await settle();
  });
}

async function enter(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
  });
}

beforeEach(() => {
  resetSurfaceCache();
  api.listRecordings.mockReset();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe("[COMP:app-web/recordings-board] recordings board paints from the surface cache", () => {
  it("first paint renders the warmed rows while the fetch is still pending", async () => {
    const key = recordingsCacheKey("w1", "all", "");
    await loadSurfaceCache(key, async () => [rec("r1", "Weekly sync")]);
    markSurfaceCacheStale(key);
    api.listRecordings.mockReturnValue(pending());

    await mount();

    expect(host!.textContent).toContain("Weekly sync");
    expect(host!.querySelector("[aria-busy]")).toBeNull();
    expect(host!.textContent).not.toContain(en.recordings.panelLoading);
    expect(api.listRecordings).toHaveBeenCalledTimes(1);
  });

  it("a cold cache paints skeleton rows, never the Loading sentence (N4)", async () => {
    api.listRecordings.mockReturnValue(pending());
    await mount();
    expect(host!.querySelector("[aria-busy]")).not.toBeNull();
    expect(host!.textContent).not.toContain(en.recordings.panelLoading);
  });

  it("a mark-stale repaints behind the paint: rows stay up, then update", async () => {
    const key = recordingsCacheKey("w1", "all", "");
    await loadSurfaceCache(key, async () => [rec("r1", "Weekly sync")]);
    await mount();

    let resolveList: (rows: RecordingSummary[]) => void = () => {};
    api.listRecordings.mockReturnValue(
      new Promise<RecordingSummary[]>((resolve) => {
        resolveList = resolve;
      }),
    );
    await act(async () => {
      markSurfaceCacheStale("recordings:w1");
      await settle();
    });
    expect(host!.textContent).toContain("Weekly sync");
    expect(host!.querySelector("[aria-busy]")).toBeNull();

    await act(async () => {
      resolveList([rec("r1", "Weekly sync"), rec("r2", "Board prep")]);
      await settle();
    });
    expect(host!.textContent).toContain("Board prep");
  });

  it("retries a cold failure on the current search and status without duplicate pending reads", async () => {
    api.listRecordings.mockResolvedValue([]);
    await mount();
    await act(async () => {
      host!.querySelector<HTMLButtonElement>(`[aria-label="${en.recordings.panelFilterLabel}"]`)!.click();
      await settle();
    });
    const failedOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find(option => option.textContent === en.recordings.panelFilterFailed)!;
    expect(failedOption).toBeTruthy();
    await act(async () => { failedOption.click(); await settle(); });
    api.listRecordings.mockRejectedValue(new Error("temporary local failure"));
    await enter(host!.querySelector<HTMLInputElement>('input[type="search"]')!, "planning");
    expect(host!.textContent).toContain(en.recordings.panelError);
    expect(host!.textContent).not.toContain(en.recordings.panelNoMatches);

    const retry = [...host!.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === en.recordings.panelRetry);
    expect(retry).toBeTruthy();
    let resolveRetry!: (rows: RecordingSummary[]) => void;
    api.listRecordings.mockImplementation(() => new Promise<RecordingSummary[]>(resolve => { resolveRetry = resolve; }));
    const callsBefore = api.listRecordings.mock.calls.length;
    await act(async () => { retry!.click(); retry!.click(); await settle(); });
    expect(api.listRecordings).toHaveBeenCalledTimes(callsBefore + 1);
    expect(api.listRecordings).toHaveBeenLastCalledWith("w1", { status: "failed", q: "planning", limit: 50 });
    expect(retry!.disabled).toBe(true);
    expect(retry!.getAttribute("aria-busy")).toBe("true");
    expect(host!.textContent).toContain(en.recordings.panelError);

    await act(async () => { resolveRetry([{ ...rec("r3", "Planning recording"), status: "failed" }]); await settle(); });
    expect(host!.textContent).toContain("Planning recording");
    expect(host!.textContent).not.toContain(en.recordings.panelError);
    expect(host!.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps the last good rows when a warm revalidation fails", async () => {
    const key = recordingsCacheKey("w1", "all", "");
    await loadSurfaceCache(key, async () => [rec("r1", "Last good recording")]);
    api.listRecordings.mockRejectedValue(new Error("temporary local failure"));
    await mount();
    await act(async () => { markSurfaceCacheStale("recordings:w1"); await settle(); });
    expect(host!.textContent).toContain("Last good recording");
    expect(host!.textContent).not.toContain(en.recordings.panelError);
    expect(host!.textContent).not.toContain(en.recordings.panelEmpty);
  });

  it.each([
    ["en", en], ["ja", ja], ["zh", zh], ["zh-CN", zhCN],
  ] as const)("renders the real status picker search and empty state in %s", async (locale, dictionary) => {
    api.listRecordings.mockResolvedValue([]);
    await mount(locale, dictionary as Dictionary);
    await act(async () => {
      host!.querySelector<HTMLButtonElement>(`[aria-label="${dictionary.recordings.panelFilterLabel}"]`)!.click();
      await settle();
    });
    const popupSearch = document.querySelector<HTMLInputElement>('input[role="combobox"]');
    expect(popupSearch?.placeholder).toBe(dictionary.recordings.panelFilterSearch);
    await enter(popupSearch!, "impossible-status");
    expect(document.body.textContent).toContain(dictionary.recordings.panelFilterNoResults);
    expect(document.body.textContent).not.toContain("No results found.");
  });
});
