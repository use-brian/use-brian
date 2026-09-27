/**
 * [COMP:app-web/surface-prefetch] — the pure half of intent prefetch: the cache
 * keys, the warm targets, and the workspace id parsed out of a link's href.
 *
 * These matter because the KEY IS THE CONTRACT. A hover warms
 * `surfaceDataKey('tasks', wid)` and the Tasks surface mounts reading the same
 * call. If the two ever produce different strings the prefetch still "works" —
 * it just fills a slot nobody reads, and every navigation silently pays full
 * price again while looking like it was optimised. That is exactly what the
 * CRM warm did until 2026-09-08: it filled the bare `crm:<wid>` key while the
 * surface read `crm:<wid>:config`, `:collection:...`, `:lookups`, ... and
 * never the bare one. So beyond pinning the strings, the last block reads each
 * surface's SOURCE and checks it builds its key with the builder the warm
 * target uses.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const user = vi.hoisted(() => ({ id: null as string | null }));
vi.mock("@/lib/user", () => ({
  getUserInfo: () => (user.id ? { id: user.id, name: "n", email: "e" } : null),
}));
// The warm targets import the API SDKs; they are never called here.
vi.mock("@/lib/api/crm", () => ({ fetchCrmConfig: vi.fn() }));
vi.mock("@/lib/api/tasks", () => ({ fetchWorkspaceTasks: vi.fn() }));
vi.mock("@/lib/api/workflow", () => ({ listWorkflows: vi.fn() }));
vi.mock("@/lib/api/views", () => ({ getView: vi.fn(), listWorkspaceAssistants: vi.fn() }));
import { chatRosterCacheKey } from "@/lib/surface-prefetch";

import {
  associationModuleCacheKey,
  assistantDetailCacheKey,
  assistantsCacheKey,
  brainKeysCacheKey,
  brandCacheKey,
  channelsCacheKey,
  connectorsCacheKey,
  crmConfigCacheKey,
  docPageCacheKey,
  feedPlanCacheKey,
  feedSessionsCacheFamily,
  feedSessionsCacheKey,
  feedWorkspaceCacheKey,
  ingestSourcesCacheKey,
  kbInstancesCacheKey,
  kbSourcesCacheKey,
  kbTabCacheKey,
  surfaceDataKey,
  warmTargetFor,
  whatsappIngestCacheKey,
  workspaceIdFromPath,
  workspaceMembershipCacheKey,
  homeDockCacheKey,
  sidebarTreeCacheKey,
  workspaceDetailCacheKey,
  workflowDetailCacheKey,
  workflowRunCacheKey,
  type WarmableSurface,
} from "@/lib/surface-prefetch";

afterEach(() => {
  user.id = null;
});

// The doc-shell panel + Brain detail builders (Phase 3 steps 2 / 5). A
// second import of the same module keeps this block independent of the
// list above, which other surfaces extend concurrently.
import {
  approvalSkillDetailsCacheKey,
  approvalsCacheKey,
  brainBlueprintCacheKey,
  brainEntityCacheKey,
  brainEntryCacheKey,
  brainSkillCacheKey,
  goalDetailCacheKey,
  goalsCacheKey,
  recordingsCacheKey,
  triageCacheKey,
} from "@/lib/surface-prefetch";

describe("[COMP:app-web/surface-prefetch] Surface prefetch keys", () => {
  it("keys the warmable surfaces per workspace", () => {
    expect(surfaceDataKey("tasks", "w1")).toBe("tasks:w1");
    expect(surfaceDataKey("crm", "w1")).toBe("crm:w1");
    expect(surfaceDataKey("workflow", "w1")).toBe("workflow:w1");
  });

  it("appends the signed-in viewer so two accounts in one tab never share a list (N2)", () => {
    // Rows depend on the caller's RLS visibility; the multi-account switcher
    // can change the viewer without a reload.
    user.id = "u1";
    expect(surfaceDataKey("tasks", "w1")).toBe("tasks:w1:u1");
    expect(surfaceDataKey("crm", "w1")).toBe("crm:w1:u1");
    expect(crmConfigCacheKey("w1")).toBe("crm:w1:u1:config");
    user.id = "u2";
    expect(surfaceDataKey("tasks", "w1")).not.toBe("tasks:w1:u1");
  });

  it("keeps the workspace FIRST so prefix marks and invalidations still match every viewer variant", () => {
    user.id = "u1";
    for (const key of [surfaceDataKey("tasks", "w1")!, crmConfigCacheKey("w1")]) {
      expect(key.startsWith("tasks:w1") || key.startsWith("crm:w1:")).toBe(true);
    }
  });

  it("scopes keys by workspace so two workspaces never share a list", () => {
    expect(surfaceDataKey("tasks", "w1")).not.toBe(surfaceDataKey("tasks", "w2"));
  });

  it("returns null for surfaces with no single landing list", () => {
    // Brain's graph, Studio's per-section fetches and the doc surface's
    // per-page metadata are deliberately not keyed here — a half-right key
    // would mask a miss rather than warm anything.
    expect(surfaceDataKey("brain", "w1")).toBeNull();
    expect(surfaceDataKey("studio", "w1")).toBeNull();
    expect(surfaceDataKey("p", "w1")).toBeNull();
    expect(surfaceDataKey(null, "w1")).toBeNull();
  });

  it("returns null without a workspace id", () => {
    expect(surfaceDataKey("tasks", null)).toBeNull();
    expect(surfaceDataKey("tasks", undefined)).toBeNull();
    expect(surfaceDataKey("tasks", "")).toBeNull();
  });

  it("keys doc pages per page, not per surface", () => {
    expect(docPageCacheKey("abc")).toBe("page:abc");
    expect(docPageCacheKey("abc")).not.toBe(docPageCacheKey("def"));
  });

  it("keys the Studio section lists workspace-first with the viewer appended", () => {
    user.id = "u1";
    expect(channelsCacheKey("w1")).toBe("channels:w1:u1");
    expect(assistantsCacheKey("w1")).toBe("assistants:w1:u1");
    expect(assistantDetailCacheKey("w1", "a1")).toBe("assistant:w1:u1:a1");
    expect(workspaceMembershipCacheKey("w1")).toBe("workspace-membership:w1:u1");
    expect(kbSourcesCacheKey("w1")).toBe("kb-sources:w1:u1");
    expect(kbInstancesCacheKey("w1")).toBe("kb-instances:w1:u1");
    expect(ingestSourcesCacheKey("w1")).toBe("ingest-sources:w1:u1");
    expect(whatsappIngestCacheKey("w1")).toBe("whatsapp-ingest:w1:u1");
    expect(brainKeysCacheKey("w1")).toBe("brain-keys:w1:u1");
    expect(brandCacheKey("w1")).toBe("brand:w1:u1");
    // The spine's `assistants:<wid>` and `assistant:<wid>:` prefixes must
    // each match exactly their own family.
    expect(assistantsCacheKey("w1").startsWith("assistants:w1")).toBe(true);
    expect(assistantDetailCacheKey("w1", "a1").startsWith("assistant:w1:")).toBe(true);
    expect(assistantsCacheKey("w1").startsWith("assistant:w1:")).toBe(false);
  });

  it("keys the assistant Knowledge tab per assistant, like doc pages", () => {
    user.id = "u1";
    expect(kbTabCacheKey("a1")).toBe("kb-tab:a1:u1");
    expect(kbTabCacheKey("a1")).not.toBe(kbTabCacheKey("a2"));
  });

  it("keys a workflow's detail and its runs workspace-first under the families the spine marks", () => {
    user.id = "u1";
    expect(workflowDetailCacheKey("w1", "wf1")).toBe("workflow-detail:w1:u1:wf1");
    expect(workflowRunCacheKey("w1", "run1")).toBe("workflow-run:w1:u1:run1");
    // `workflow-detail:<wid>:` / `workflow-run:<wid>:` are the map's prefixes;
    // the bare `workflow:<wid>` list family must NOT swallow them.
    expect(workflowDetailCacheKey("w1", "wf1").startsWith("workflow-detail:w1:")).toBe(true);
    expect(workflowRunCacheKey("w1", "run1").startsWith("workflow-run:w1:")).toBe(true);
    expect(workflowDetailCacheKey("w1", "wf1").startsWith("workflow:w1")).toBe(false);
  });

  it("parses the workspace id out of an in-app href", () => {
    expect(workspaceIdFromPath("/w/w1/tasks")).toBe("w1");
    expect(workspaceIdFromPath("/w/w1/p/page-id")).toBe("w1");
    expect(workspaceIdFromPath("/w/w1")).toBe("w1");
    expect(workspaceIdFromPath("/w/w1?x=1")).toBe("w1");
  });

  it("returns null for hrefs outside a workspace", () => {
    expect(workspaceIdFromPath("/teams")).toBeNull();
    expect(workspaceIdFromPath("/login")).toBeNull();
    expect(workspaceIdFromPath("")).toBeNull();
  });
});

/**
 * Every warm key must equal a key its surface reads. The warm target names
 * the builder; the surface's source must call that same builder for the same
 * surface. A warm that fills a slot nobody reads is silent by construction,
 * so this is the only place it can fail.
 */
describe("[COMP:app-web/surface-prefetch] every warm key is a key its surface reads", () => {
  const src = (rel: string) => readFileSync(resolve(process.cwd(), "src", rel), "utf8");
  const SURFACES: Record<WarmableSurface, { source: string; builder: string }> = {
    association: {
      source: "components/association/module-controls.tsx",
      builder: "associationModuleCacheKey(workspaceId)",
    },
    tasks: {
      source: "components/tasks/tasks-surface.tsx",
      builder: 'surfaceDataKey("tasks", workspaceId)',
    },
    crm: {
      source: "components/crm/crm-surface.tsx",
      builder: "crmConfigCacheKey(workspaceId)",
    },
    workflow: {
      source: "app/w/[workspaceId]/workflow/page.tsx",
      builder: 'surfaceDataKey("workflow", activeId)',
    },
    // The Studio root redirects to Connectors, so the Studio icon warms the
    // connectors list; the page reads it through its data hook.
    studio: {
      source: "app/w/[workspaceId]/studio/connectors/use-connectors-list.ts",
      builder: "connectorsCacheKey(workspaceId)",
    },
    // The Chat icon warms the roster; the sidebar panel and the surface both
    // read it through the one Chat data hook.
    chat: {
      source: "lib/chat-surface-data.ts",
      builder: "chatRosterCacheKey(wid)",
    },
    // The Live icon warms the roster; the sidebar and the surface both read
    // it through the one roster hook.
    live: {
      source: "components/live/use-live-roster.ts",
      builder: "liveRosterCacheKey(workspaceId)",
    },
    // The Office icon warms the active files list; the home reads every
    // lifecycle view through the same builder.
    office: {
      source: "components/office/office-home.tsx",
      builder: "officeListCacheKey(workspaceId, view, viewerId)",
    },
    // The Feed icon warms the shell gate's record; the provider (and the
    // sidebar post list) read it through the same builder.
    feed: {
      source: "contexts/feed-profiles-context.tsx",
      builder: "feedWorkspaceCacheKey(workspaceId)",
    },
    // The Shopify icon warms the reachability answer; the surface and the
    // sidebar panel both read it (the panel is checked in its own block).
    shopify: {
      source: "components/shopify/shopify-surface.tsx",
      builder: "shopifyToolsCacheKey(workspaceId)",
    },
  };

  for (const [surface, { source, builder }] of Object.entries(SURFACES) as Array<
    [WarmableSurface, { source: string; builder: string }]
  >) {
    it(`${surface}: the surface reads the builder the warm target fills`, () => {
      user.id = "u1";
      const target = warmTargetFor(surface, "w1");
      const expected =
        surface === "association"
          ? associationModuleCacheKey("w1")
          : surface === "crm"
          ? crmConfigCacheKey("w1")
          : surface === "studio"
            ? connectorsCacheKey("w1")
            : surface === "chat"
              ? chatRosterCacheKey("w1")
              : surface === "live"
                ? liveRosterCacheKey("w1")
                : surface === "office"
                  ? officeListCacheKey("w1", "active")
                  : surface === "feed"
                    ? feedWorkspaceCacheKey("w1")
                    : surface === "shopify"
                      ? shopifyToolsCacheKey("w1")
                      : surfaceDataKey(surface, "w1");
      expect(target.key).toBe(expected);
      expect(typeof target.fetch).toBe("function");
      // The surface builds its key through the SAME builder, from the prefetch
      // module — never a hand-rebuilt string.
      const text = src(source);
      expect(text).toContain(builder);
      expect(text).toContain('from "@/lib/surface-prefetch"');
    });
  }

  it("keys the Feed surfaces workspace-first with the viewer, and its families match the spine and the local signal", () => {
    user.id = "u1";
    expect(feedWorkspaceCacheKey("w1")).toBe("feed-workspace:w1:u1");
    expect(feedSessionsCacheKey("w1", "threads")).toBe("feed-sessions:w1:u1:threads");
    expect(feedPlanCacheKey("w1", "a1", "2026-09")).toBe("feed-plan:w1:u1:a1:2026-09");
    // The spine marks `feed-workspace:<wid>`; the local posts-changed signal
    // marks the whole sessions family (it fires with no workspace in hand).
    expect(feedWorkspaceCacheKey("w1").startsWith("feed-workspace:w1")).toBe(true);
    expect(feedSessionsCacheKey("w1", "threads").startsWith(feedSessionsCacheFamily())).toBe(true);
    expect(feedSessionsCacheKey("w1", "threads").startsWith("feed-sessions:w1")).toBe(true);
    // The warm fills the record the shell gate reads; the loader is reached
    // through a dynamic import so the feed SDK never closes a cycle here.
    expect(warmTargetFor("feed", "w1").key).toBe("feed-workspace:w1:u1");
  });

  it("the Studio warm fills the connectors list, viewer-suffixed like every RLS-scoped list", () => {
    user.id = "u1";
    expect(connectorsCacheKey("w1")).toBe("connectors:w1:u1");
    expect(warmTargetFor("studio", "w1").key).toBe("connectors:w1:u1");
    // Studio itself still has no single landing key: connectors is keyed by
    // its own builder, never a half-right `surfaceDataKey("studio")`.
    expect(surfaceDataKey("studio", "w1")).toBeNull();
    // The page never rebuilds the string by hand.
    const page = src("app/w/[workspaceId]/studio/connectors/page.tsx");
    expect(page).not.toMatch(/["'`]connectors:/);
    expect(page).toContain('from "./use-connectors-list"');
  });

  it("the CRM warm fills the config region, the first thing the surface needs to paint", () => {
    expect(warmTargetFor("crm", "w1").key).toMatch(/^crm:w1(:[^:]+)?:config$/);
    // The bare root key is a family prefix, not a slot anything reads.
    expect(src("components/crm/crm-surface.tsx")).not.toMatch(/useCachedResource\(\s*crmKey\s*,/);
  });
});

/**
 * Doc-shell panel + Brain detail keys (Phase 3 steps 2 / 5). Each surface
 * imports its builder from this module; the spine map marks the family
 * prefix, so every key here must START with the prefix its event marks and
 * carry the viewer between the workspace and the discriminators.
 */
describe("[COMP:app-web/surface-prefetch] panel and brain detail keys", () => {
  const src = (rel: string) => readFileSync(resolve(process.cwd(), "src", rel), "utf8");

  it("keys the doc-shell panels workspace-first with the viewer, then the view discriminators", () => {
    user.id = "u1";
    expect(approvalsCacheKey("w1")).toBe("approvals:w1:u1");
    expect(approvalSkillDetailsCacheKey("w1")).toBe("approvals:w1:u1:skills");
    expect(goalsCacheKey("w1", "all")).toBe("goals:w1:u1:all");
    expect(triageCacheKey("w1")).toBe("triage:w1:u1");
    expect(goalDetailCacheKey("w1", "g1")).toBe("goal:w1:u1:g1");
    expect(recordingsCacheKey("w1", "all", " hello ")).toBe("recordings:w1:u1:all:hello");
    // Family prefixes the spine marks (`approvals:<wid>`, `goals:<wid>`,
    // `triage:<wid>`, `goal:<wid>:`) each match exactly their own family.
    expect(approvalSkillDetailsCacheKey("w1").startsWith("approvals:w1")).toBe(true);
    expect(goalsCacheKey("w1", "all").startsWith("goal:w1:")).toBe(false);
    expect(goalDetailCacheKey("w1", "g1").startsWith("goals:w1")).toBe(false);
  });

  it("keys the Brain detail routes per row, workspace-first with the viewer", () => {
    user.id = "u1";
    expect(brainEntityCacheKey("w1", "e1")).toBe("brain-entity:w1:u1:e1");
    expect(brainEntryCacheKey("w1", "knowledge", "k1")).toBe("brain-entry:w1:u1:knowledge:k1");
    expect(brainSkillCacheKey("w1", "s1")).toBe("brain-skill:w1:u1:s1");
    expect(brainBlueprintCacheKey("w1", "t1")).toBe("brain-blueprint:w1:u1:t1");
    for (const [key, prefix] of [
      [brainEntityCacheKey("w1", "e1"), "brain-entity:w1:"],
      [brainEntryCacheKey("w1", "memories", "m1"), "brain-entry:w1:"],
      [brainSkillCacheKey("w1", "s1"), "brain-skill:w1:"],
      [brainBlueprintCacheKey("w1", "t1"), "brain-blueprint:w1:"],
    ]) {
      expect(key.startsWith(prefix)).toBe(true);
    }
  });

  it("every panel and brain detail surface imports its builder from this module", () => {
    const pairs: Array<[string, string]> = [
      ["components/doc/panels/approvals-panel.tsx", "approvalsCacheKey("],
      ["components/doc/panels/approvals-panel.tsx", "approvalSkillDetailsCacheKey("],
      ["components/doc/panels/autopilot-panel.tsx", "goalsCacheKey("],
      ["components/doc/panels/triage-panel.tsx", "triageCacheKey("],
      ["app/w/[workspaceId]/goals/[goalId]/page.tsx", "goalDetailCacheKey("],
      ["components/doc/panels/recordings-panel.tsx", "recordingsCacheKey("],
      ["app/w/[workspaceId]/brain/[entityId]/page.tsx", "brainEntityCacheKey("],
      ["app/w/[workspaceId]/brain/entry/[kind]/[id]/page.tsx", "brainEntryCacheKey("],
      ["app/w/[workspaceId]/brain/skills/[skillRowId]/page.tsx", "brainSkillCacheKey("],
      ["app/w/[workspaceId]/brain/blueprints/[templateId]/page.tsx", "brainBlueprintCacheKey("],
    ];
    for (const [source, builder] of pairs) {
      const text = src(source);
      expect(text, `${source} reads ${builder}`).toContain(builder);
      expect(text, `${source} imports from surface-prefetch`).toContain('from "@/lib/surface-prefetch"');
    }
  });
});

// The Office builders (Phase 3 step 2, report E "Office home / editor"). A
// separate import keeps this block independent of the lists above.
vi.mock("@/lib/office/api", () => ({ listOfficeArtifacts: vi.fn() }));
import {
  invalidateOfficeList,
  officeArtifactCacheKey,
  officeListCacheFamily,
  officeListCacheKey,
  officeSnapshotCacheKey,
  warmTargetFor as warmOfficeTarget,
} from "@/lib/surface-prefetch";

describe("[COMP:app-web/office-surface-cache] Office cache keys", () => {
  it("keys each Office home view per workspace and viewer, workspace first", () => {
    user.id = "u1";
    expect(officeListCacheKey("w1", "active")).toBe("office:w1:u1:active");
    expect(officeListCacheKey("w1", "trash")).toBe("office:w1:u1:trash");
    expect(officeListCacheKey("w1", "active").startsWith(officeListCacheFamily("w1"))).toBe(true);
    user.id = "u2";
    expect(officeListCacheKey("w1", "active")).not.toBe("office:w1:u1:active");
    expect(officeListCacheKey("w2", "active")).not.toBe(officeListCacheKey("w1", "active"));
  });

  it("keys the open artifact's row and snapshot separately so the shell fetches them in parallel (N7)", () => {
    expect(officeArtifactCacheKey("a1")).toBe("office-artifact:a1");
    expect(officeSnapshotCacheKey("a1")).toBe("office-snapshot:a1");
    expect(officeArtifactCacheKey("a1")).not.toBe(officeSnapshotCacheKey("a1"));
  });

  it("the Office warm fills the active list the home reads through the same builder", () => {
    user.id = "u1";
    const target = warmOfficeTarget("office", "w1");
    expect(target.key).toBe(officeListCacheKey("w1", "active"));
    expect(typeof target.fetch).toBe("function");
    const home = readFileSync(resolve(process.cwd(), "src", "components/office/office-home.tsx"), "utf8");
    expect(home).toContain("officeListCacheKey(workspaceId, view, viewerId)");
    expect(home).toContain('from "@/lib/surface-prefetch"');
    const shell = readFileSync(resolve(process.cwd(), "src", "components/office/office-editor-shell.tsx"), "utf8");
    expect(shell).toContain("officeArtifactCacheKey(artifactId)");
    expect(shell).toContain("officeSnapshotCacheKey(artifactId)");
  });

  it("invalidateOfficeList is a no-op without a workspace id (the store round trip lives in the jsdom office test)", () => {
    expect(() => invalidateOfficeList(null)).not.toThrow();
    expect(() => invalidateOfficeList(undefined)).not.toThrow();
  });
});

/**
 * Shell keys (Phase 3 shell adoption): the home dock slot the sidebar-data
 * provider AND the workspace root share, and the in-memory sidebar tree slot.
 * Both are RLS-scoped, so both carry the viewer; both are workspace-first so
 * the spine's `home-dock:<wid>` mark reaches every viewer variant.
 */
describe("[COMP:app-web/surface-prefetch] shell keys (home dock, sidebar tree)", () => {
  it("keys the home dock per workspace + viewer, workspace first", () => {
    user.id = "u1";
    expect(homeDockCacheKey("w1")).toBe("home-dock:w1:u1");
    expect(homeDockCacheKey("w1").startsWith("home-dock:w1")).toBe(true);
    user.id = "u2";
    expect(homeDockCacheKey("w1")).not.toBe("home-dock:w1:u1");
    user.id = null;
    expect(homeDockCacheKey("w1")).toBe("home-dock:w1");
  });

  it("keys the sidebar tree per workspace + viewer, and never collides with the disk family", () => {
    user.id = "u1";
    expect(sidebarTreeCacheKey("w1")).toBe("sidebar:w1:u1");
    expect(sidebarTreeCacheKey("w1")).not.toBe(sidebarTreeCacheKey("w2"));
    // The IndexedDB copies are `sidebar:<kind>:<wid>:<viewer>` in another
    // store; the memory slot is `sidebar:<wid>:<viewer>` here. Different
    // shapes, so a prefix mark on one can never be mistaken for the other.
    expect(sidebarTreeCacheKey("w1")).not.toMatch(/^sidebar:(saved|drafts|all|teamspaces):/);
  });

  it("keys the Settings workspace detail row per workspace + viewer, apart from the membership key", () => {
    user.id = "u1";
    expect(workspaceDetailCacheKey("w1")).toBe("workspace-detail:w1:u1");
    expect(workspaceDetailCacheKey("w1").startsWith("workspace-detail:w1")).toBe(true);
    // Studio's membership projection is a different family.
    expect(workspaceDetailCacheKey("w1").startsWith("workspace-membership:")).toBe(false);
    const text = readFileSync(
      resolve(process.cwd(), "src", "components/settings-modal/workspace-sections.tsx"),
      "utf8",
    );
    expect(text).toContain("workspaceDetailCacheKey(workspaceId)");
    expect(text).toContain('from "@/lib/surface-prefetch"');
  });

  it("the sidebar Inbox badge reads the flyout's slot through the builder and carries no inbox refetch listener", () => {
    const text = readFileSync(
      resolve(process.cwd(), "src", "components/doc/doc-sidebar.tsx"),
      "utf8",
    );
    expect(text).toContain("inboxCacheKey(workspaceId)");
    expect(text).toContain("useCachedResource<InboxPayload>");
    // One request for the badge and the flyout: no private badge fetch, and
    // the spine's `INBOX_REFRESH_EVENT` reaches it through the map only.
    expect(text).not.toContain("fetchInboxBadgeCount");
    // The badge's own comment names the events to say why no listener
    // exists, so match the import and the listener forms, not the token.
    expect(text).not.toMatch(/import\s*\{[^}]*INBOX_(?:REFRESH|CHANGED)_EVENT/);
    expect(text).not.toMatch(/addEventListener\(\s*INBOX_/);
  });

  it("the provider reads both shell keys through the builders, never a hand-built string", () => {
    const text = readFileSync(
      resolve(process.cwd(), "src", "components/doc/doc-sidebar-data.tsx"),
      "utf8",
    );
    expect(text).toContain("homeDockCacheKey(workspaceId)");
    expect(text).toContain("sidebarTreeCacheKey(workspaceId)");
    expect(text).toContain('from "@/lib/surface-prefetch"');
    expect(text).not.toMatch(/`home-dock:\$\{/);
  });
});

// The Live roster and Inbox flyout keys (Phase 3 step 2, report E "Live" and
// "Inbox (flyout)" rows). A separate import keeps this block independent of
// the lists above.
vi.mock("@/lib/api/live", () => ({ fetchLiveRoster: vi.fn() }));
import {
  inboxCacheKey,
  liveRosterCacheKey,
  warmTargetFor as warmLiveTarget,
} from "@/lib/surface-prefetch";

describe("[COMP:app-web/live-roster-cache] Live roster and Inbox cache keys", () => {
  it("keys the roster per workspace + viewer, workspace first, and the Live icon warms that exact key", () => {
    user.id = "u1";
    expect(liveRosterCacheKey("w1")).toBe("live:w1:u1");
    expect(liveRosterCacheKey("w1")).not.toBe(liveRosterCacheKey("w2"));
    // The spine's bare `live:<wid>` prefix must match every viewer variant.
    expect(liveRosterCacheKey("w1").startsWith("live:w1")).toBe(true);
    const target = warmLiveTarget("live", "w1");
    expect(target.key).toBe("live:w1:u1");
    expect(typeof target.fetch).toBe("function");
    // Live has no `surfaceDataKey` entry: the roster is keyed by its own
    // builder, never a half-right generic key.
    expect(surfaceDataKey("live", "w1")).toBeNull();
  });

  it("the roster hook reads the builder the warm fills and carries no spine listener of its own", () => {
    const text = readFileSync(
      resolve(process.cwd(), "src", "components/live/use-live-roster.ts"),
      "utf8",
    );
    expect(text).toContain("liveRosterCacheKey(workspaceId)");
    expect(text).toContain('from "@/lib/surface-prefetch"');
    expect(text).not.toMatch(/`live:\$\{/);
    // Staleness comes from the one map, never from a listener here (N3).
    // The header comment names the events it no longer listens to; the code
    // must not import or subscribe to them (only the window `focus` refetch).
    expect(text).not.toContain('from "@/lib/workspace-events"');
    expect(text).not.toContain('from "@/lib/workflow-events"');
    expect(text.match(/addEventListener\(([^,]+),/g) ?? []).toEqual([
      'addEventListener("focus",',
    ]);
  });

  it("keys the Inbox flyout per workspace + viewer, and the panel reads it through the builder", () => {
    user.id = "u1";
    expect(inboxCacheKey("w1")).toBe("inbox:w1:u1");
    expect(inboxCacheKey("w1").startsWith("inbox:w1")).toBe(true);
    const text = readFileSync(
      resolve(process.cwd(), "src", "components/doc/inbox-panel.tsx"),
      "utf8",
    );
    expect(text).toContain("inboxCacheKey(workspaceId)");
    expect(text).toContain('from "@/lib/surface-prefetch"');
    expect(text).not.toMatch(/`inbox:\$\{/);
    // No refetch listener of its own: the panel neither imports the spine
    // event nor subscribes to anything but Escape-to-close.
    expect(text).not.toContain('from "@/lib/inbox-refresh-events"');
    expect(text.match(/addEventListener\(([^,]+),/g) ?? []).toEqual([
      'addEventListener("keydown",',
    ]);
  });
});

// The Shopify keys (Phase 3 step 2, report E "Shopify" and "Shopify sidebar
// panel" rows). A separate import keeps this block independent of the lists
// above.
vi.mock("@/lib/api/shopify", () => ({ listTools: vi.fn() }));
import {
  shopifyDraftsCacheKey,
  shopifyToolsCacheKey,
  warmTargetFor as warmShopifyTarget,
} from "@/lib/surface-prefetch";

describe("[COMP:app-web/shopify-surface-cache] Shopify cache keys", () => {
  it("keys reachability and drafts per workspace + viewer, workspace first, as two distinct families", () => {
    user.id = "u1";
    expect(shopifyToolsCacheKey("w1")).toBe("shopify:w1:u1");
    expect(shopifyDraftsCacheKey("w1")).toBe("shopify-drafts:w1:u1");
    expect(shopifyToolsCacheKey("w1")).not.toBe(shopifyToolsCacheKey("w2"));
    // A mark on `shopify:<wid>` must never reach the drafts family, and the
    // other way round.
    expect(shopifyDraftsCacheKey("w1").startsWith("shopify:w1")).toBe(false);
    expect(shopifyToolsCacheKey("w1").startsWith("shopify-drafts:")).toBe(false);
    user.id = "u2";
    expect(shopifyToolsCacheKey("w1")).not.toBe("shopify:w1:u1");
    user.id = null;
    expect(shopifyToolsCacheKey("w1")).toBe("shopify:w1");
    // Shopify has no `surfaceDataKey` entry: reachability is keyed by its own
    // builder, never a half-right generic key.
    expect(surfaceDataKey("shopify", "w1")).toBeNull();
  });

  it("the Shopify warm fills the reachability key BOTH the surface and the sidebar panel read", () => {
    user.id = "u1";
    const target = warmShopifyTarget("shopify", "w1");
    expect(target.key).toBe(shopifyToolsCacheKey("w1"));
    expect(typeof target.fetch).toBe("function");
    const read = (rel: string) => readFileSync(resolve(process.cwd(), "src", rel), "utf8");
    const surface = read("components/shopify/shopify-surface.tsx");
    const panel = read("components/doc/sidebar-panels/shopify-sidebar-panel.tsx");
    for (const text of [surface, panel]) {
      expect(text).toContain("shopifyToolsCacheKey(workspaceId)");
      expect(text).toContain('from "@/lib/surface-prefetch"');
      // Never a hand-built string on either side.
      expect(text).not.toMatch(/["'`]shopify(?:-drafts)?:\$\{/);
      expect(text).not.toMatch(/["']shopify(?:-drafts)?:/);
    }
    expect(panel).toContain("shopifyDraftsCacheKey(workspaceId)");
    // No refetch listener of its own on either side: an external store has
    // no spine primitive, so both rely on mount revalidation (N3).
    expect(surface).not.toMatch(/addEventListener\(/);
    expect(panel).not.toMatch(/addEventListener\(/);
  });
});
