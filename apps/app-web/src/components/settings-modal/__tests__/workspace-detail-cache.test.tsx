// @vitest-environment jsdom
/**
 * [COMP:app-web/workspace-sections] Settings -> Workspace General / Members
 * paint the workspace detail row from the surface cache (instant-navigation
 * contract N1 / N3 / N4).
 *
 * Both sections used to fetch `GET /api/workspaces/:id` on every mount and
 * return a "Loading..." sentence until it answered (the `surface-entry-
 * skeleton` check's two findings in this file). They now share ONE cached
 * slot (`workspaceDetailCacheKey`): a warmed row paints the roster on the
 * first frame with the fetch still pending; a cold slot paints skeleton rows,
 * never the sentence; and the `workspace_config` spine signal revalidates
 * behind the paint - the old row stays up until the new one lands.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const { authFetchMock } = vi.hoisted(() => ({ authFetchMock: vi.fn() }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: authFetchMock }));
vi.mock("@/lib/user", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/user")>()),
  getUserInfo: () => ({ id: "u1", name: "Me", email: "me@example.com" }),
}));
vi.mock("@/lib/workspace-context", () => ({
  useWorkspaceContext: () => ({ workspaceId: "w1", name: "Acme" }),
  emitWorkspaceIconChanged: vi.fn(),
  emitWorkspaceRenamed: vi.fn(),
}));
vi.mock("@/lib/i18n/client", async () => {
  const { en } = await import("@/lib/i18n/dictionaries/en");
  const { format } = await import("@/lib/i18n/format");
  return { useT: () => en, format };
});

import { WORKSPACE_IDENTITY_REFRESH_EVENT } from "@/lib/workspace-identity-events";
import { applySpineEventToSurfaceCache } from "@/lib/surface-cache-invalidation";
import { loadSurfaceCache, resetSurfaceCache } from "@/lib/surface-cache";
import { workspaceDetailCacheKey } from "@/lib/surface-prefetch";
import { WorkspaceMembersSection } from "../workspace-sections";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function detail(memberName: string) {
  return {
    id: "w1",
    name: "Acme",
    purpose: "Ship",
    ownerUserId: "u1",
    isPersonal: false,
    role: "owner",
    members: [
      { userId: "u1", role: "owner", email: "me@example.com", userName: "Me" },
      { userId: "u2", role: "member", email: "them@example.com", userName: memberName },
    ],
  };
}

/** authFetch by URL: invitations answer at once, the detail row is controlled per test. */
function routeFetch(detailImpl: () => Promise<unknown>) {
  authFetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith("/invitations")) {
      return { ok: true, json: async () => ({ invitations: [] }) };
    }
    return detailImpl();
  });
}

const detailFetches = () =>
  authFetchMock.mock.calls.filter(([url]) => !String(url).endsWith("/invitations")).length;

describe("[COMP:app-web/workspace-sections] detail row from the cache", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    resetSurfaceCache();
    authFetchMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  async function mount() {
    await act(async () => {
      root!.render(<WorkspaceMembersSection />);
      await settle();
    });
  }

  it("first paint comes from the warmed row with the fetch still pending", async () => {
    await loadSurfaceCache(workspaceDetailCacheKey("w1"), async () => detail("Warm member"));
    routeFetch(() => new Promise(() => {}));

    await mount();

    expect(container!.textContent).toContain("Warm member");
    expect(container!.querySelector("[aria-busy]")).toBeNull();
    expect(container!.textContent).not.toContain("Loading");
    // A fresh slot is not refetched on mount.
    expect(detailFetches()).toBe(0);
  });

  it("a cold slot paints skeleton rows, never the sentence, then the roster", async () => {
    let release: (value: unknown) => void = () => {};
    routeFetch(
      () => new Promise((resolve) => {
        release = resolve;
      }),
    );

    await mount();
    expect(container!.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(container!.textContent).not.toContain("Loading");
    expect(detailFetches()).toBe(1);

    await act(async () => {
      release({ ok: true, json: async () => detail("Net member") });
      await settle();
    });
    expect(container!.querySelector("[aria-busy]")).toBeNull();
    expect(container!.textContent).toContain("Net member");
  });

  it("the workspace_config spine signal revalidates behind the paint", async () => {
    await loadSurfaceCache(workspaceDetailCacheKey("w1"), async () => detail("Warm member"));
    let release: (value: unknown) => void = () => {};
    routeFetch(
      () => new Promise((resolve) => {
        release = resolve;
      }),
    );
    await mount();
    expect(container!.textContent).toContain("Warm member");

    await act(async () => {
      applySpineEventToSurfaceCache(WORKSPACE_IDENTITY_REFRESH_EVENT, { workspaceId: "w1" }, "w1");
      await settle();
    });
    // Stale, not gone: the roster stays up while the refetch is in flight.
    expect(detailFetches()).toBe(1);
    expect(container!.textContent).toContain("Warm member");
    expect(container!.querySelector("[aria-busy]")).toBeNull();

    await act(async () => {
      release({ ok: true, json: async () => detail("Renamed member") });
      await settle();
    });
    expect(container!.textContent).toContain("Renamed member");
    expect(container!.textContent).not.toContain("Warm member");
  });

  it("a failed revalidation keeps the row on screen and does not re-run", async () => {
    await loadSurfaceCache(workspaceDetailCacheKey("w1"), async () => detail("Warm member"));
    routeFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    await mount();

    await act(async () => {
      applySpineEventToSurfaceCache(WORKSPACE_IDENTITY_REFRESH_EVENT, null, "w1");
      await settle();
      await settle();
    });
    expect(container!.textContent).toContain("Warm member");
    // One attempt for the mark, not a loop against the failing endpoint.
    expect(detailFetches()).toBe(1);
  });
  it.each([401,403,404])('evicts the roster after an authorization/not-found response (%s)',async status=>{
    await loadSurfaceCache(workspaceDetailCacheKey('w1'),async()=>detail('Former visible member'));
    routeFetch(async()=>({ok:false,status,json:async()=>({})}));await mount();
    await act(async()=>{applySpineEventToSurfaceCache(WORKSPACE_IDENTITY_REFRESH_EVENT,null,'w1');await settle();});
    expect(container!.textContent).not.toContain('Former visible member');
    expect(detailFetches()).toBe(1);
  });
});
