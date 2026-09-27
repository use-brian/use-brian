// @vitest-environment jsdom
/**
 * [COMP:app-web/surface-cache-invalidation] The ONE spine-to-cache map
 * (instant-navigation contract N3).
 *
 * Two findings this pins. Tasks and CRM read the surface cache but never
 * subscribed to the spine, so a task or deal an assistant wrote from chat
 * reached the sidebar counts (which do subscribe) but not the open list until
 * the 30s stale window elapsed. And a spine signal must mark stale, never
 * invalidate: the open list keeps painting and revalidates behind the paint.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { BRAIN_REFRESH_EVENT } from "@/lib/brain-events";
import { APPROVALS_REFRESH_EVENT } from "@/lib/approvals-events";
import { WORKFLOW_REFRESH_EVENT } from "@/lib/workflow-events";
import { ASSISTANT_REFRESH_EVENT } from "@/lib/assistant-events";
import {
  SKILL_REFRESH_EVENT,
  LIVE_REFRESH_EVENT,
  SCHEDULED_JOB_REFRESH_EVENT,
} from "@/lib/workspace-events";
import { INBOX_REFRESH_EVENT } from "@/lib/inbox-refresh-events";
import { GOAL_REFRESH_EVENT } from "@/lib/goal-events";
import { WORKSPACE_IDENTITY_REFRESH_EVENT } from "@/lib/workspace-identity-events";
import { HOME_APPS_REFRESH_EVENT } from "@/lib/home-apps-events";

describe("[COMP:app-web/surface-cache-invalidation] Association module signals", () => {
  it("marks the viewer-scoped module state on workspace configuration changes", () => {
    expect(staleMarksFor(HOME_APPS_REFRESH_EVENT, "w1")).toContain("association-module:w1");
  });
});
import {
  SURFACE_CACHE_SPINE_EVENTS,
  applySpineEventToSurfaceCache,
  staleMarksFor,
} from "@/lib/surface-cache-invalidation";
import {
  isSurfaceCacheStale,
  loadSurfaceCache,
  readSurfaceCache,
  resetSurfaceCache,
} from "@/lib/surface-cache";

describe("[COMP:app-web/surface-cache-invalidation] routing table", () => {
  it("maps the brain primitives to the Tasks list, every CRM region and the graph", () => {
    for (const prefix of ["tasks:w1", "crm:w1:", "brain-graph:w1:", "kb-sources:w1"]) {
      expect(staleMarksFor(BRAIN_REFRESH_EVENT, "w1")).toContain(prefix);
    }
  });

  it("marks the Knowledge sources list on a brain change (kb_chunk is a brain primitive)", () => {
    expect(staleMarksFor(BRAIN_REFRESH_EVENT, "w1")).toContain("kb-sources:w1");
    // Ingest sources have no spine primitive today: nothing marks them.
    for (const event of SURFACE_CACHE_SPINE_EVENTS) {
      expect(staleMarksFor(event, "w1")).not.toContain("ingest-sources:w1");
    }
  });

  it("maps the orchestration primitives to their surfaces", () => {
    expect(staleMarksFor(APPROVALS_REFRESH_EVENT, "w1")).toContain("approvals:w1");
    // The list, the editable detail (mark-stale only, never invalidate) and
    // the run drill-down all move on the one workflow event.
    expect(staleMarksFor(WORKFLOW_REFRESH_EVENT, "w1")).toEqual([
      "workflow:w1",
      "workflow-detail:w1:",
      "workflow-run:w1:",
      "live:w1",
    ]);
    // The Studio rail, the per-assistant detail family and the chat roster
    // all move with an assistant change (other lists ride along; see the
    // map for the full set).
    for (const prefix of ["assistants:w1", "assistant:w1:", "chat-roster:w1"]) {
      expect(staleMarksFor(ASSISTANT_REFRESH_EVENT, "w1")).toContain(prefix);
    }
    // The skill editor's `brain-skill:` family rides along (see the goal /
    // brain-detail block below).
    expect(staleMarksFor(SKILL_REFRESH_EVENT, "w1")).toContain("skills:w1");
    expect(staleMarksFor(LIVE_REFRESH_EVENT, "w1")).toEqual([
      "live:w1",
      "chat-sessions:w1",
      "chat-shared:w1",
      "feed-collaboration:w1",
    ]);
  });

  it("routes the session primitive to the Chat rail's two lists (the spine gap report E named)", () => {
    // A thread created, retitled or settled anywhere in the workspace moves
    // the Chat rail, which used to rely on a same-tab bus alone.
    const live = staleMarksFor(LIVE_REFRESH_EVENT, "w1");
    expect(live).toContain("chat-sessions:w1");
    expect(live).toContain("chat-shared:w1");
    // The personal list is a fan-out over the roster, so a roster change
    // marks it too; the roster key itself was already on the map.
    const assistant = staleMarksFor(ASSISTANT_REFRESH_EVENT, "w1");
    expect(assistant).toContain("chat-roster:w1");
    expect(assistant).toContain("chat-sessions:w1");
    // Transcripts are per session and driven by the surface, never the spine.
    for (const event of SURFACE_CACHE_SPINE_EVENTS) {
      for (const prefix of staleMarksFor(event, "w1")) {
        expect(prefix.startsWith("chat-transcript:")).toBe(false);
      }
    }
  });

  it("marks the Live roster on every signal that changes what is running or about to", () => {
    // The roster hook used to listen to these three itself; it now reads the
    // cache and the map is its only trigger (N3). A session lifecycle change,
    // a workflow run starting / settling, and a schedule edit (what is about
    // to fire) all move the roster.
    expect(staleMarksFor(LIVE_REFRESH_EVENT, "w1")).toContain("live:w1");
    expect(staleMarksFor(WORKFLOW_REFRESH_EVENT, "w1")).toContain("live:w1");
    expect(staleMarksFor(SCHEDULED_JOB_REFRESH_EVENT, "w1")).toEqual(["live:w1"]);
    expect(SURFACE_CACHE_SPINE_EVENTS).toContain(SCHEDULED_JOB_REFRESH_EVENT);
    // The Inbox flyout reads `inbox:<wid>:<viewer>`; the bare prefix matches it.
    expect(staleMarksFor(INBOX_REFRESH_EVENT, "w1")).toEqual(["inbox:w1"]);
  });

  it("marks the Feed shell's record on a workspace rename and on an assistant change (report E's Feed gate row)", () => {
    // `workspace_config` moves the name / role the record carries; an
    // assistant change moves the distribution assistants folded into it.
    // `toContain`, not `toEqual`: the Settings workspace-detail row rides the
    // same signal (see "a workspace_config change marks the Settings detail row").
    expect(staleMarksFor(WORKSPACE_IDENTITY_REFRESH_EVENT, "w1")).toContain("feed-workspace:w1");
    expect(staleMarksFor(ASSISTANT_REFRESH_EVENT, "w1")).toContain("feed-workspace:w1");
    expect(SURFACE_CACHE_SPINE_EVENTS).toContain(WORKSPACE_IDENTITY_REFRESH_EVENT);
    // The session and plan lists have no server primitive: the local
    // posts-changed signal owns the sessions family, and nothing on the
    // spine touches the plan.
    for (const event of SURFACE_CACHE_SPINE_EVENTS) {
      for (const prefix of staleMarksFor(event, "w1")) {
        expect(prefix.startsWith("feed-sessions:")).toBe(false);
        expect(prefix.startsWith("feed-plan:")).toBe(false);
      }
    }
  });

  it("every listened event has at least one prefix, and every prefix is workspace-first", () => {
    for (const event of SURFACE_CACHE_SPINE_EVENTS) {
      const marks = staleMarksFor(event, "w1");
      expect(marks.length).toBeGreaterThan(0);
      for (const prefix of marks) expect(prefix).toMatch(/^[a-z-]+:w1(:|$)/);
    }
  });

  it("returns nothing for an event it does not know (a newer client vocabulary must not throw)", () => {
    expect(staleMarksFor("sidan:something-new", "w1")).toEqual([]);
  });

  it("an approval change marks the home dock (the Suggested badge, Home pane and workspace root read it)", () => {
    // The provider used to carry its own APPROVALS listener for the dock;
    // the map is the one place now, so the root's landing decision, the
    // sidebar badge and the Home pane all revalidate off one mark.
    expect(staleMarksFor(APPROVALS_REFRESH_EVENT, "w1")).toContain("home-dock:w1");
    expect(staleMarksFor(APPROVALS_REFRESH_EVENT, "w2")).not.toContain("home-dock:w1");
  });

  it("a workspace_config change marks the Settings detail row (name, icon, purpose, roster)", () => {
    expect(staleMarksFor(WORKSPACE_IDENTITY_REFRESH_EVENT, "w1")).toContain("workspace-detail:w1");
  });
});

describe("[COMP:app-web/surface-cache-invalidation] marks stale without dropping data", () => {
  beforeEach(() => {
    resetSurfaceCache();
  });

  it("BRAIN_REFRESH_EVENT makes tasks:<wid> and crm:<wid>: stale and keeps their rows", async () => {
    // Viewer-keyed variants are what the surfaces actually read.
    await loadSurfaceCache("tasks:w1:u1", async () => ["t1"]);
    await loadSurfaceCache("crm:w1:u1:config", async () => ({ pipelines: [] }));
    await loadSurfaceCache("tasks:w2:u1", async () => ["other"]);
    expect(isSurfaceCacheStale("tasks:w1:u1")).toBe(false);

    applySpineEventToSurfaceCache(BRAIN_REFRESH_EVENT, { workspaceId: "w1" }, "w1");

    expect(isSurfaceCacheStale("tasks:w1:u1")).toBe(true);
    expect(isSurfaceCacheStale("crm:w1:u1:config")).toBe(true);
    // Stale, not gone: the open list keeps painting while it revalidates.
    expect(readSurfaceCache<string[]>("tasks:w1:u1").data).toEqual(["t1"]);
    expect(readSurfaceCache("crm:w1:u1:config").data).toEqual({ pipelines: [] });
    // Another workspace's list is untouched.
    expect(isSurfaceCacheStale("tasks:w2:u1")).toBe(false);
  });

  it("ignores an event that names a different workspace, applies the catch-up shape", async () => {
    await loadSurfaceCache("tasks:w1:u1", async () => ["t1"]);
    applySpineEventToSurfaceCache(BRAIN_REFRESH_EVENT, { workspaceId: "w9" }, "w1");
    expect(isSurfaceCacheStale("tasks:w1:u1")).toBe(false);
    // The stream's catch-up burst carries no workspace id on some events.
    applySpineEventToSurfaceCache(BRAIN_REFRESH_EVENT, null, "w1");
    expect(isSurfaceCacheStale("tasks:w1:u1")).toBe(true);
  });
});

/**
 * The `goal` primitive (Phase 3 step 3): the goals board, the Triage panel and
 * every goal detail used to rely on a local `refetchTick` only the acting tab
 * could bump. One event now marks all three families, and the brain detail
 * routes ride the brain / skill events the same way.
 */
describe("[COMP:app-web/surface-cache-invalidation] goal primitive and brain detail routes", () => {
  beforeEach(() => {
    resetSurfaceCache();
  });

  it("GOAL_REFRESH_EVENT marks the board, the triage queue and every goal detail", () => {
    expect(staleMarksFor(GOAL_REFRESH_EVENT, "w1")).toEqual([
      "goals:w1",
      "triage:w1",
      "goal:w1:",
      "feed-collaboration:w1",
    ]);
    expect(SURFACE_CACHE_SPINE_EVENTS).toContain(GOAL_REFRESH_EVENT);
  });

  it("a goal change keeps the board's rows while it revalidates, per status slot", async () => {
    await loadSurfaceCache("goals:w1:u1:all", async () => ["g1"]);
    await loadSurfaceCache("goals:w1:u1:done", async () => ["g9"]);
    await loadSurfaceCache("triage:w1:u1", async () => ["d1"]);
    await loadSurfaceCache("goal:w1:u1:g1", async () => ({ id: "g1" }));
    // `goal:<wid>:` must not swallow `goals:<wid>` and vice versa - they are
    // different families with different fetchers.
    await loadSurfaceCache("goals:w2:u1:all", async () => ["other"]);

    applySpineEventToSurfaceCache(GOAL_REFRESH_EVENT, { workspaceId: "w1" }, "w1");

    for (const key of ["goals:w1:u1:all", "goals:w1:u1:done", "triage:w1:u1", "goal:w1:u1:g1"]) {
      expect(isSurfaceCacheStale(key)).toBe(true);
      expect(readSurfaceCache(key).data).toBeDefined();
    }
    expect(isSurfaceCacheStale("goals:w2:u1:all")).toBe(false);
  });

  it("a custom-app change marks the app strip AND every open app's session (renderable state, entry URL)", () => {
    const marks = staleMarksFor(HOME_APPS_REFRESH_EVENT, "w1");
    expect(marks).toContain("home-apps:w1");
    expect(marks).toContain("home-app-session:w1:");
    // Computer, Projects and the Settings sections have no spine primitive:
    // nothing marks them; they revalidate on mount / visibility (N3).
    for (const event of SURFACE_CACHE_SPINE_EVENTS) {
      for (const prefix of ["browser-profiles:w1", "computer-tasks:w1", "project:w1", "settings-models:w1"]) {
        expect(staleMarksFor(event, "w1")).not.toContain(prefix);
      }
    }
  });

  it("brain changes mark the entity / entry / blueprint detail keys; skill changes mark the skill editor's", () => {
    const brain = staleMarksFor(BRAIN_REFRESH_EVENT, "w1");
    expect(brain).toContain("brain-entity:w1:");
    expect(brain).toContain("brain-entry:w1:");
    expect(brain).toContain("brain-blueprint:w1:");
    // The skill editor is an editable draft: it is marked (never invalidated)
    // and the page dirty-checks before adopting the revalidated row.
    expect(staleMarksFor(SKILL_REFRESH_EVENT, "w1")).toContain("brain-skill:w1:");
    expect(brain).not.toContain("brain-skill:w1:");
  });
});


it('[COMP:app-web/surface-cache-invalidation] purges only the changed workspace media',async()=>{
  await loadSurfaceCache('doc-media:w1:viewer:file',async()=>'restricted');
  await loadSurfaceCache('doc-media:w2:viewer:file',async()=>'other');
  applySpineEventToSurfaceCache(WORKSPACE_IDENTITY_REFRESH_EVENT,{workspaceId:'w1'},'w1');
  expect(readSurfaceCache('doc-media:w1:viewer:file').data).toBeUndefined();
  expect(readSurfaceCache('doc-media:w2:viewer:file').data).toBe('other');
});

it('[COMP:app-web/surface-cache-invalidation] purges the bounded member directory on authority and profile signals',async()=>{
  await loadSurfaceCache('workspace-member-directory:w1:viewer',async()=>'restricted');
  await loadSurfaceCache('workspace-member-directory:w2:viewer',async()=>'other');
  applySpineEventToSurfaceCache(BRAIN_REFRESH_EVENT,{workspaceId:'w1'},'w1');
  expect(readSurfaceCache('workspace-member-directory:w1:viewer').data).toBeUndefined();
  expect(readSurfaceCache('workspace-member-directory:w2:viewer').data).toBe('other');
  await loadSurfaceCache('workspace-member-directory:w1:viewer',async()=>'renewed');
  applySpineEventToSurfaceCache(WORKSPACE_IDENTITY_REFRESH_EVENT,{workspaceId:'w1'},'w1');
  expect(readSurfaceCache('workspace-member-directory:w1:viewer').data).toBeUndefined();
});
