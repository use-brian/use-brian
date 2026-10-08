// @vitest-environment jsdom
/**
 * [COMP:app-web/live-roster-cache] The Live roster on the surface cache
 * (instant-navigation contract N1 / N3 / N4, report E "Live" row).
 *
 * What this pins: the persistent sidebar and the Live surface both call
 * `useLiveRoster`, so before the cache every entry into `/live` fired the
 * roster request TWICE and painted empty rail groups until the second copy
 * landed. Now the two mounts share one slot and one request, a warmed key
 * paints on the first frame with the fetch still pending, a spine mark-stale
 * repaints without a blank frame, and a cold cache shows skeleton rows rather
 * than the "Quiet" empty signal.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { LiveSessionItem, LiveWorkItem } from "@/lib/api/live";
import {
  loadSurfaceCache,
  markSurfaceCacheStale,
  resetSurfaceCache,
} from "@/lib/surface-cache";
import { liveRosterCacheKey } from "@/lib/surface-prefetch";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

vi.mock("@/lib/user", () => ({
  getUserInfo: () => ({ id: "u1", name: "n", email: "e" }),
}));

const fetchLiveRoster = vi.fn<(workspaceId: string) => Promise<LiveWorkItem[]>>();
vi.mock("@/lib/api/live", () => ({
  liveRosterRemaining: () => 30_000,
  fetchLiveRoster: (...a: [string]) => fetchLiveRoster(...a),
}));

// next/link and useSearchParams are only needed by the SSR half; the hook
// itself is framework-free apart from React.
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

import { useLiveRoster, type LiveRosterState } from "../use-live-roster";
import { LiveOverviewSkeleton } from "../live-surface";
import { LiveRosterList } from "@/components/doc/sidebar-panels/live-sidebar-panel";

const dict = en as unknown as Dictionary;

function session(id: string, overrides: Partial<LiveSessionItem> = {}): LiveSessionItem {
  return {
    kind: "session",
    tier: "full",
    id,
    assistantId: "assistant-1",
    assistantName: "Brian",
    assistantIconSeed: 42,
    ownerUserId: "user-1",
    ownerName: "Owner",
    channelType: "web",
    state: "working",
    startedAt: "2026-08-30T00:00:00.000Z",
    lastActiveAt: "2026-08-30T00:00:00.000Z",
    ...overrides,
  };
}

/** A fetch the test resolves by hand, so "still pending" is a real state. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

let root: Root | null = null;
let container: HTMLDivElement;
const seen: LiveRosterState[] = [];

function Probe({ id }: { id: string }) {
  const state = useLiveRoster("w1");
  seen.push(state);
  return (
    <span
      data-probe={id}
      data-items={state.items.length}
      data-loaded={String(state.loaded)}
      data-error={String(state.error)}
    />
  );
}

function probe(id: string): { items: number; loaded: boolean; error: boolean } {
  const el = container.querySelector(`[data-probe="${id}"]`) as HTMLElement;
  return {
    items: Number(el.dataset.items),
    loaded: el.dataset.loaded === "true",
    error: el.dataset.error === "true",
  };
}

async function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
}

beforeEach(() => {
  resetSurfaceCache();
  fetchLiveRoster.mockReset();
  seen.length = 0;
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
});

describe("[COMP:app-web/live-roster-cache] useLiveRoster on the surface cache", () => {
  it("two mounts (sidebar + surface) share one slot and fire ONE request", async () => {
    const pending = deferred<LiveWorkItem[]>();
    fetchLiveRoster.mockReturnValue(pending.promise);
    await mount(
      <>
        <Probe id="sidebar" />
        <Probe id="surface" />
      </>,
    );
    expect(fetchLiveRoster).toHaveBeenCalledTimes(1);
    expect(fetchLiveRoster).toHaveBeenCalledWith("w1");
    // Cold: nothing to paint yet, and the consumer can tell (skeleton, not
    // "Quiet").
    expect(probe("sidebar").loaded).toBe(false);
    expect(probe("surface").loaded).toBe(false);

    await act(async () => {
      pending.resolve([session("s1"), session("s2")]);
      await settle();
    });
    expect(probe("sidebar")).toEqual({ items: 2, loaded: true, error: false });
    expect(probe("surface")).toEqual({ items: 2, loaded: true, error: false });
    expect(fetchLiveRoster).toHaveBeenCalledTimes(1);
  });

  it("paints from a warmed key on the FIRST render, with no request in flight", async () => {
    await loadSurfaceCache(liveRosterCacheKey("w1"), async () => [session("s1")]);
    fetchLiveRoster.mockReturnValue(new Promise(() => {}));
    await mount(<Probe id="surface" />);
    // The very first state the hook handed out already carried the roster:
    // no empty-then-fill frame.
    expect(seen[0].items).toHaveLength(1);
    expect(seen[0].loaded).toBe(true);
    expect(probe("surface")).toEqual({ items: 1, loaded: true, error: false });
    // Fresh cache: nothing refetched.
    expect(fetchLiveRoster).not.toHaveBeenCalled();
  });

  it("a spine mark-stale (`live:<wid>`) repaints without a blank frame, then adopts the new roster", async () => {
    await loadSurfaceCache(liveRosterCacheKey("w1"), async () => [session("s1")]);
    const next = deferred<LiveWorkItem[]>();
    fetchLiveRoster.mockReturnValue(next.promise);
    await mount(<Probe id="surface" />);
    expect(fetchLiveRoster).not.toHaveBeenCalled();

    // What the one map does on LIVE / WORKFLOW / SCHEDULED_JOB events: the
    // bare workspace prefix matches the viewer-suffixed key.
    await act(async () => {
      markSurfaceCacheStale("live:w1");
      await settle();
    });
    expect(fetchLiveRoster).toHaveBeenCalledTimes(1);
    // Revalidating behind the paint: the old roster is still up, never [].
    expect(probe("surface")).toEqual({ items: 1, loaded: true, error: false });
    for (const state of seen) expect(state.loaded).toBe(true);

    await act(async () => {
      next.resolve([session("s1"), session("s2"), session("s3")]);
      await settle();
    });
    expect(probe("surface").items).toBe(3);
  });

  it("a failed revalidation keeps the last good roster and reports the error", async () => {
    await loadSurfaceCache(liveRosterCacheKey("w1"), async () => [session("s1")]);
    fetchLiveRoster.mockRejectedValue(new Error("network"));
    await mount(<Probe id="surface" />);
    await act(async () => {
      markSurfaceCacheStale("live:w1");
      await settle();
    });
    expect(probe("surface")).toEqual({ items: 1, loaded: true, error: true });
  });

  it("window focus marks the roster stale and refetches (the one trigger the spine cannot supply)", async () => {
    await loadSurfaceCache(liveRosterCacheKey("w1"), async () => [session("s1")]);
    fetchLiveRoster.mockResolvedValue([session("s1"), session("s2")]);
    await mount(<Probe id="surface" />);
    expect(fetchLiveRoster).not.toHaveBeenCalled();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await settle();
    });
    expect(fetchLiveRoster).toHaveBeenCalledTimes(1);
    expect(probe("surface").items).toBe(2);
  });

  it("carries no data listener of its own: staleness is the one map's job (N3)", () => {
    const text = readFileSync(
      resolve(process.cwd(), "src", "components/live/use-live-roster.ts"),
      "utf8",
    );
    // The header comment may NAME the events (it documents the map); the code
    // must not import or subscribe to them.
    expect(text).not.toContain('from "@/lib/workspace-events"');
    expect(text).not.toContain('from "@/lib/workflow-events"');
    const subscriptions = text.match(/addEventListener\(([^,]+),/g) ?? [];
    expect(subscriptions).toEqual(['addEventListener("focus",']);
    expect(text).toContain("liveRosterCacheKey(workspaceId)");
  });
});

describe("[COMP:app-web/live-roster-cache] cold fallback is a skeleton, never an empty-then-fill", () => {
  function wrap(node: React.ReactNode): string {
    return renderToString(
      <I18nProvider locale="en" dict={dict}>
        {node}
      </I18nProvider>,
    );
  }

  it("the sidebar groups show skeleton rows while the roster is cold, and the empty signal once loaded", () => {
    const cold = wrap(
      <LiveRosterList
        workspaceId="w1"
        items={[]}
        loaded={false}
        error={false}
        activeFocus={null}
        inboxOpen={false}
        inboxCount={0}
        onToggleInbox={() => {}}
      />,
    );
    expect(cold).toContain("data-live-roster-skeleton");
    expect(cold).not.toContain(en.liveApp.emptyWorking);
    expect(cold).not.toContain(en.liveApp.emptyFinished);

    const loaded = wrap(
      <LiveRosterList
        workspaceId="w1"
        items={[]}
        loaded
        error={false}
        activeFocus={null}
        inboxOpen={false}
        inboxCount={0}
        onToggleInbox={() => {}}
      />,
    );
    expect(loaded).not.toContain("data-live-roster-skeleton");
    expect(loaded).toContain(en.liveApp.emptyWorking);
    expect(loaded).toContain(en.liveApp.emptyFinished);
  });

  it("the overview skeleton draws the four zone cards and no copy", () => {
    const html = wrap(<LiveOverviewSkeleton />);
    expect(html).toContain("data-live-overview-skeleton");
    expect(html.match(/<section/g)?.length).toBe(4);
    expect(html).not.toContain("Loading");
  });
});
