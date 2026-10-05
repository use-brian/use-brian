// @vitest-environment jsdom
/**
 * [COMP:app-web/studio-lists-cache] Studio section lists paint from the cache.
 *
 * Every Studio section (Channels, Assistants, Knowledge, Ingest rules,
 * Programmatic access, Brand) and the assistant Knowledge tab used to gate
 * their first frame on a mount fetch and paint "Loading..." for the round
 * trip. Each now reads a `lib/surface-prefetch.ts` key through
 * `useCachedResource`, so two things must hold per surface (instant-navigation
 * contract N1 / N3 / N4):
 *
 *  (a) a warmed key paints the rows on the FIRST frame while the fetch is
 *      still pending - no skeleton, no loading text;
 *  (b) a spine mark-stale repaints without a blank frame - the rows stay up
 *      while the revalidation runs, then update.
 *
 * The data layers are the small hooks beside each page (the pages pull the
 * whole Studio chrome, so they are not rendered here); the Knowledge tab is
 * light enough to render directly.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  listChannels: vi.fn(),
  listChannelAssistants: vi.fn(),
  listAssistants: vi.fn(),
  authFetch: vi.fn(),
  getWhatsappIngest: vi.fn(),
  listBrainKeys: vi.fn(),
  listOAuthAuthorizations: vi.fn(),
  listContextTeams: vi.fn(),
  listContextProjects: vi.fn(),
  listCaptureProfiles: vi.fn(),
}));

vi.mock("@/lib/user", () => ({
  getUserInfo: () => ({ id: "u1", name: "n", email: "e" }),
}));
vi.mock("@/lib/api/channels", () => ({
  listChannels: api.listChannels,
  listChannelAssistants: api.listChannelAssistants,
}));
vi.mock("@/lib/api/studio", () => ({ listAssistants: api.listAssistants }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: api.authFetch }));
vi.mock("@/lib/sidebar-cache", () => ({ onAssistantsChanged: () => () => {} }));
vi.mock("@/lib/api/whatsapp-ingest", () => ({ getWhatsappIngest: api.getWhatsappIngest }));
vi.mock("@/lib/api/brain-keys", () => ({ listBrainKeys: api.listBrainKeys }));
vi.mock("@/lib/api/oauth-authorizations", () => ({
  listOAuthAuthorizations: api.listOAuthAuthorizations,
}));
vi.mock("@/lib/api/context-scopes", () => ({
  listContextTeams: api.listContextTeams,
  listContextProjects: api.listContextProjects,
}));
vi.mock("@/lib/api/programmatic-capture", () => ({
  listCaptureProfiles: api.listCaptureProfiles,
}));
vi.mock("@/lib/i18n/client", async () => {
  const { en } = await import("@/lib/i18n/dictionaries/en");
  return { useT: () => en, useLocale: () => "en" };
});

import {
  loadSurfaceCache,
  markSurfaceCacheStale,
  resetSurfaceCache,
} from "@/lib/surface-cache";
import {
  assistantsCacheKey,
  brainKeysCacheKey,
  brandCacheKey,
  channelsCacheKey,
  ingestSourcesCacheKey,
  kbSourcesCacheKey,
  kbTabCacheKey,
} from "@/lib/surface-prefetch";
import { useChannelsData, type ChannelsSnapshot } from "../channels/use-channels-data";
import { mergeSidebarAssistants, useAssistantsData } from "../assistants/use-assistants-data";
import { useKnowledgeData, type KbSourcesSnapshot } from "../knowledge/use-knowledge-data";
import { useIngestData, type IngestSourcesSnapshot } from "../ingest-rules/use-ingest-data";
import {
  useBrainKeysData,
  type BrainKeysSnapshot,
} from "../programmatic-access/use-brain-keys-data";
import { useBrandData, type BrandSnapshot } from "../brand/use-brand-data";
import { KnowledgeTab, type KbTabSnapshot } from "@/components/knowledge-tab";

const NEVER = () => new Promise<never>(() => {});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const okJson = (body: unknown) => ({ ok: true, json: async () => body });

/**
 * Renders a hook's rows, or a `cold` marker when the hook has nothing to
 * paint. `read` calls the hook, so hook order is stable per probe.
 */
function Probe({
  read,
}: {
  read: () => { rows: string[] | null; revalidating: boolean };
}) {
  const r = read();
  if (r.rows === null) return <p data-testid="cold">skeleton</p>;
  return (
    <ul data-revalidating={String(r.revalidating)}>
      {r.rows.map((row) => (
        <li key={row}>{row}</li>
      ))}
    </ul>
  );
}

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  resetSurfaceCache();
  for (const fn of Object.values(api)) fn.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

function mount(element: React.ReactNode) {
  act(() => root!.render(element));
}

const cold = () => container.querySelector('[data-testid="cold"]');
const revalidating = () => container.querySelector("ul")?.getAttribute("data-revalidating");

type Case = {
  name: string;
  key: () => string;
  /** The spine's prefix for the family (workspace-first, no viewer). */
  prefix: string;
  warm: () => unknown;
  /** Arm the mocks so the surface's fetch hangs forever. */
  armPending: () => void;
  /** Arm the mocks with a deferred the test resolves to `next`. */
  armDeferred: () => { resolve: () => void };
  read: () => { rows: string[] | null; revalidating: boolean };
  first: string;
  next: string;
};

const chan = (id: string, displayName: string) =>
  ({ id, displayName, channelType: "telegram", status: "active" }) as never;

const CASES: Case[] = [
  {
    name: "channels",
    key: () => channelsCacheKey("w1"),
    prefix: "channels:w1",
    warm: () => ({ channels: [chan("c1", "Ops")], routing: {} }) satisfies ChannelsSnapshot,
    armPending: () => {
      api.listChannels.mockImplementation(NEVER);
      api.listAssistants.mockImplementation(NEVER);
      api.authFetch.mockImplementation(NEVER);
    },
    armDeferred: () => {
      const d = deferred<unknown>();
      api.listChannels.mockReturnValue(d.promise);
      api.listChannelAssistants.mockResolvedValue([]);
      api.listAssistants.mockResolvedValue([]);
      api.authFetch.mockResolvedValue({ ok: false });
      return { resolve: () => d.resolve([chan("c1", "Ops"), chan("c2", "Sales")]) };
    },
    read: () => {
      const d = useChannelsData("w1");
      return {
        rows: d.channels?.map((c) => c.displayName) ?? null,
        revalidating: d.revalidating,
      };
    },
    first: "Ops",
    next: "Sales",
  },
  {
    name: "assistants",
    key: () => assistantsCacheKey("w1"),
    prefix: "assistants:w1",
    warm: () => [{ id: "a1", name: "Ada", workspaceId: "w1", channels: [] }],
    armPending: () => api.listAssistants.mockImplementation(NEVER),
    armDeferred: () => {
      const d = deferred<unknown>();
      api.listAssistants.mockReturnValue(d.promise);
      return {
        resolve: () =>
          d.resolve([
            { id: "a1", name: "Ada", workspaceId: "w1", channels: [] },
            { id: "a2", name: "Grace", workspaceId: "w1", channels: [] },
          ]),
      };
    },
    read: () => {
      const d = useAssistantsData("w1");
      return { rows: d.assistants?.map((a) => a.name) ?? null, revalidating: d.revalidating };
    },
    first: "Ada",
    next: "Grace",
  },
  {
    name: "knowledge sources",
    key: () => kbSourcesCacheKey("w1"),
    prefix: "kb-sources:w1",
    warm: () =>
      ({
        sources: [{ id: "s1", repo: "acme/handbook" } as never],
        manualCount: 0,
      }) satisfies KbSourcesSnapshot,
    armPending: () => api.authFetch.mockImplementation(NEVER),
    armDeferred: () => {
      const d = deferred<unknown>();
      api.authFetch.mockImplementation((url: string) =>
        url.includes("/knowledge/sources") ? d.promise : Promise.resolve({ ok: false }),
      );
      return {
        resolve: () =>
          d.resolve(
            okJson({
              sources: [
                { id: "s1", repo: "acme/handbook" },
                { id: "s2", repo: "acme/runbooks" },
              ],
              manualCount: 0,
            }),
          ),
      };
    },
    read: () => {
      const d = useKnowledgeData("w1");
      return { rows: d.sources?.map((s) => s.repo) ?? null, revalidating: d.revalidating };
    },
    first: "acme/handbook",
    next: "acme/runbooks",
  },
  {
    name: "ingest sources",
    key: () => ingestSourcesCacheKey("w1"),
    prefix: "ingest-sources:w1",
    warm: () =>
      ({
        sources: [{ instanceId: "i1", label: "Slack" } as never],
        available: [],
        ownedDefault: undefined,
      }) satisfies IngestSourcesSnapshot,
    armPending: () => {
      api.authFetch.mockImplementation(NEVER);
      api.getWhatsappIngest.mockImplementation(NEVER);
    },
    armDeferred: () => {
      const d = deferred<unknown>();
      api.authFetch.mockImplementation((url: string) =>
        url.includes("/api/ingest/sources") ? d.promise : Promise.resolve({ ok: false }),
      );
      api.getWhatsappIngest.mockResolvedValue(null);
      return {
        resolve: () =>
          d.resolve(
            okJson({
              sources: [
                { instanceId: "i1", label: "Slack" },
                { instanceId: "i2", label: "GitHub" },
              ],
              available: [],
            }),
          ),
      };
    },
    read: () => {
      const d = useIngestData("w1");
      return { rows: d.sources?.map((s) => s.label) ?? null, revalidating: d.revalidating };
    },
    first: "Slack",
    next: "GitHub",
  },
  {
    name: "brain keys",
    key: () => brainKeysCacheKey("w1"),
    prefix: "brain-keys:w1",
    warm: () =>
      ({
        keys: [{ id: "k1", name: "Claude Desktop", status: "active" } as never],
        authorizations: [],
        teams: [],
        projects: [],
        assistants: [],
        captureProfiles: [],
      }) satisfies BrainKeysSnapshot,
    armPending: () => {
      for (const fn of [
        api.listBrainKeys,
        api.listOAuthAuthorizations,
        api.listContextTeams,
        api.listContextProjects,
        api.listAssistants,
        api.listCaptureProfiles,
      ]) fn.mockImplementation(NEVER);
    },
    armDeferred: () => {
      const d = deferred<unknown>();
      api.listBrainKeys.mockReturnValue(d.promise);
      for (const fn of [
        api.listOAuthAuthorizations,
        api.listContextTeams,
        api.listContextProjects,
        api.listAssistants,
        api.listCaptureProfiles,
      ]) fn.mockResolvedValue([]);
      return {
        resolve: () =>
          d.resolve([
            { id: "k1", name: "Claude Desktop", status: "active" },
            { id: "k2", name: "ChatGPT", status: "active" },
          ]),
      };
    },
    read: () => {
      const d = useBrainKeysData("w1");
      return { rows: d.data?.keys.map((k) => k.name) ?? null, revalidating: d.revalidating };
    },
    first: "Claude Desktop",
    next: "ChatGPT",
  },
  {
    name: "brand",
    key: () => brandCacheKey("w1"),
    prefix: "brand:w1",
    warm: () =>
      ({
        brand: {
          id: "b1",
          slug: "acme",
          name: "Acme",
          isDefault: true,
          status: "active",
          activeVersion: 1,
          hasDraft: false,
          draft: null,
          activeRecord: null,
        },
        canApprove: true,
        versions: [],
      }) satisfies BrandSnapshot,
    armPending: () => api.authFetch.mockImplementation(NEVER),
    armDeferred: () => {
      const d = deferred<unknown>();
      api.authFetch.mockImplementation((url: string) =>
        url.endsWith("/brand/default")
          ? d.promise
          : Promise.resolve(okJson({ versions: [{ id: "v1", version: 1, approvedBy: null, approvedAt: "2026-01-01" }] })),
      );
      return {
        resolve: () =>
          d.resolve(
            okJson({
              brand: {
                id: "b1",
                slug: "acme",
                name: "Acme Corporation",
                isDefault: true,
                status: "active",
                activeVersion: 1,
                hasDraft: false,
                draft: null,
                activeRecord: null,
              },
              canApprove: true,
            }),
          ),
      };
    },
    read: () => {
      const d = useBrandData("w1");
      return {
        rows: d.data === undefined ? null : [d.data.brand?.name ?? "(none)"],
        revalidating: d.revalidating,
      };
    },
    first: "Acme",
    next: "Acme Corporation",
  },
];

describe("[COMP:app-web/studio-lists-cache] Studio section lists paint from the cache", () => {
  for (const c of CASES) {
    it(`${c.name}: a warmed key paints the rows on the first frame while the fetch is still pending (N1)`, async () => {
      await loadSurfaceCache(c.key(), async () => c.warm());
      // Stale, so the mount kicks off a revalidation - one that never lands.
      markSurfaceCacheStale(c.prefix);
      c.armPending();

      mount(<Probe read={c.read} />);

      expect(container.textContent).toContain(c.first);
      expect(cold()).toBeNull();
      expect(container.textContent).not.toMatch(/loading/i);
      expect(revalidating()).toBe("true");
    });

    it(`${c.name}: a spine mark-stale repaints without a blank frame (N3)`, async () => {
      await loadSurfaceCache(c.key(), async () => c.warm());
      const { resolve } = c.armDeferred();
      mount(<Probe read={c.read} />);
      expect(container.textContent).toContain(c.first);

      act(() => markSurfaceCacheStale(c.prefix));

      // The old rows stay up while the refetch is in flight ...
      expect(container.textContent).toContain(c.first);
      expect(cold()).toBeNull();
      expect(revalidating()).toBe("true");

      // ... and the new rows land in place.
      await act(async () => {
        resolve();
        await settle();
        await settle();
      });
      expect(container.textContent).toContain(c.next);
      expect(revalidating()).toBe("false");
    });

    it(`${c.name}: a cold key renders the skeleton state, never loading copy`, () => {
      c.armPending();
      mount(<Probe read={c.read} />);
      expect(cold()).not.toBeNull();
      expect(container.textContent).not.toMatch(/loading/i);
    });
  }
});

describe("[COMP:app-web/studio-lists-cache] the assistant Knowledge tab", () => {
  const SOURCE = {
    id: "s1",
    workspaceId: "w1",
    sourceType: "github",
    repo: "acme/handbook",
    branch: "main",
    rootPath: "",
    lastSyncedSha: null,
    lastSyncedAt: null,
    syncError: null,
    enabled: true,
  };

  it("cold: renders skeleton rows, never the retired 'Loading knowledge base' sentence (N4 / N5)", () => {
    api.authFetch.mockImplementation(NEVER);
    mount(<KnowledgeTab assistantId="a1" workspaceId="w1" />);
    expect(container.querySelector('[data-testid="knowledge-tab-skeleton"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Loading knowledge base");
  });

  it("a warmed key paints the sources on the first frame while the fetch is pending", async () => {
    await loadSurfaceCache(
      kbTabCacheKey("a1"),
      async () => ({ sources: [SOURCE], entries: [] }) satisfies KbTabSnapshot,
    );
    markSurfaceCacheStale(kbTabCacheKey("a1"));
    api.authFetch.mockImplementation(NEVER);

    mount(<KnowledgeTab assistantId="a1" workspaceId="w1" />);

    expect(container.textContent).toContain("acme/handbook");
    expect(container.querySelector('[data-testid="knowledge-tab-skeleton"]')).toBeNull();
    expect(container.textContent).not.toContain("Loading knowledge base");
  });

  it("a mark-stale keeps the sources up while the refetch runs, then updates", async () => {
    await loadSurfaceCache(
      kbTabCacheKey("a1"),
      async () => ({ sources: [SOURCE], entries: [] }) satisfies KbTabSnapshot,
    );
    const d = deferred<unknown>();
    api.authFetch.mockImplementation((url: string) =>
      url.includes("/knowledge/sources")
        ? d.promise
        : Promise.resolve(okJson({ entries: [] })),
    );
    mount(<KnowledgeTab assistantId="a1" workspaceId="w1" />);
    expect(container.textContent).toContain("acme/handbook");

    act(() => markSurfaceCacheStale(kbTabCacheKey("a1")));
    expect(container.textContent).toContain("acme/handbook");
    expect(container.querySelector('[data-testid="knowledge-tab-skeleton"]')).toBeNull();

    await act(async () => {
      d.resolve(okJson({ sources: [SOURCE, { ...SOURCE, id: "s2", repo: "acme/runbooks" }] }));
      await settle();
      await settle();
    });
    expect(container.textContent).toContain("acme/runbooks");
  });
});

describe("[COMP:app-web/studio-lists-cache] sidebar-cache merge into the rail", () => {
  it("merges only the rendered fields for ids already in the list, keeping identity when nothing changed", () => {
    const prev = [
      { id: "a1", name: "Ada", workspaceId: "w1", channels: [], iconSeed: 1, clearance: "internal" },
      { id: "a2", name: "Grace", workspaceId: "w1", channels: [] },
    ];
    const same = mergeSidebarAssistants(prev, [
      { id: "a1", name: "Ada", iconSeed: 1, clearance: "internal" } as never,
      { id: "zz", name: "Not in rail" } as never,
    ]);
    expect(same).toBe(prev);

    const next = mergeSidebarAssistants(prev, [
      { id: "a1", name: "Ada Lovelace", iconSeed: 7, clearance: "public" } as never,
    ]);
    expect(next).not.toBe(prev);
    expect(next[0]).toMatchObject({ id: "a1", name: "Ada Lovelace", iconSeed: 7, clearance: "public" });
    expect(next[1]).toBe(prev[1]);
    // The rail never gains a row from the sidebar cache - creation goes
    // through the page's own optimistic insert.
    expect(next).toHaveLength(2);
  });
});
