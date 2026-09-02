/**
 * Bundled-desktop SPA (Approach B, Phase 2) — HashRouter + the workspace shell.
 *
 * Reconstructs, as client providers + routes, the tree the Next App-Router
 * layouts give:
 *   root layout   → ThemeProvider + I18nProvider                   (app-level, here)
 *   w/[id]/layout → WorkspaceContextProvider + CustomThemesProvider
 *                   + DocSidebarDataProvider + BrainSurfaceProvider
 *                   + WorkspaceChrome (the persistent sidebar)       (per workspace)
 *   the surface   → the doc page shell (`/p`), Brain, Studio, Workflow,
 *                   Feed, Approvals, Knowledge-base — each its own child
 *                   route rendered in `WorkspaceChrome`'s `<Outlet/>` slot.
 *
 * EVERY `/w/[id]/*` surface that the Next build serves as a file route gets a
 * matching child route here. Without one, a sidebar click (e.g. Brain →
 * `/w/<id>/brain`) matches no route, falls through to the top-level `*`
 * catch-all, and bounces the user back to the workspace picker — the
 * desktop-only "redirect to choose workspace" bug. The surface pages/layouts
 * are imported verbatim from the Next route tree so the two builds can't drift.
 *
 * HashRouter (not Browser/Memory) because the bundle loads from `file://`, where
 * the history API path is the file path; the hash carries the app route, and
 * `useLocation().pathname` (what app-web parses) is the post-`#` path.
 *
 * A `<Suspense>` boundary wraps the surface `<Outlet/>` (in `WorkspaceShell`).
 * It is load-bearing, not optional: the reused Next pages read params with
 * `use(props.params)`, which suspends for a microtask on first render. The Next
 * App Router supplies a boundary around every layout/page; the SPA has to add
 * its own. Without it, entering any `/w/[id]/*` surface suspends to the root
 * with no fallback and unmounts the whole tree (React #482), leaving only the
 * blank "Use Brian" boot frame.
 */
import { lazy, useEffect, useMemo, useState, Suspense, type ReactNode } from "react";
import {
  HashRouter,
  Routes,
  Route,
  Navigate,
  Outlet,
  useParams,
  useNavigate,
  useLocation,
} from "react-router-dom";

import { authFetch, getValidAccessToken } from "@/lib/auth-fetch";
import { desktopBridge, desktopSignOut } from "@/lib/desktop-auth-source";
import { idbGet, idbSet } from "@/lib/offline/idb";
import { ThemeProvider } from "@/lib/theme";
import { I18nProvider } from "@/lib/i18n/client";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { ConfirmDialogProvider } from "@/components/ui/confirm-dialog";
import { PromptDialogProvider } from "@/components/ui/prompt-dialog";
import { KindPickerDialogProvider } from "@/components/ui/kind-picker-dialog";
import { WorkspaceContextProvider, type WorkspaceContextValue } from "@/lib/workspace-context";
import { CustomThemesProvider } from "@/lib/custom-themes";
import { DocSidebarDataProvider } from "@/components/doc/doc-sidebar-data";
import { BrainSurfaceProvider } from "@/contexts/brain-surface-context";
import { PrimaryAssistantProvider } from "@/contexts/primary-assistant";
import { WorkspaceChrome } from "@/components/doc/workspace-chrome";
import { DesktopChatWindow } from "@/components/chrome/desktop-chat-window";
import { WorkspacePicker } from "@/components/workspace-picker";
import {
  usesScalableWorkspacePicker,
  type WorkspacePickerItem,
} from "@/lib/workspace-picker";
import {
  OPERATOR_APP_KEYS,
  type OperatorAppKey,
} from "@/lib/operator-apps";
import {
  DESKTOP_WORKSPACES_CACHE_KEY,
  desktopWorkspaceCacheKey,
  parseDesktopWorkspaceContext,
  parseDesktopWorkspaceRows,
} from "./offline-bootstrap";

import { isFeedPlatform } from "@/lib/feed-nav";
import { isOssEdition } from "@/lib/edition";

// Route surfaces are local Vite chunks, loaded from disk on first entry. This
// keeps the startup shell small without reintroducing network navigation.
const DocSurfaceLayout = lazy(() => import("@/app/w/[workspaceId]/p/layout"));
const BrainPage = lazy(() => import("@/app/w/[workspaceId]/brain/page"));
const BrainEntityPage = lazy(() => import("@/app/w/[workspaceId]/brain/[entityId]/page"));
const BrainSkillEditorPage = lazy(() => import("@/app/w/[workspaceId]/brain/skills/[skillRowId]/page"));
const BrainEntryReaderPage = lazy(() => import("@/app/w/[workspaceId]/brain/entry/[kind]/[id]/page"));
const StudioLayout = lazy(() => import("@/app/w/[workspaceId]/studio/layout"));
const StudioAssistantsPage = lazy(() => import("@/app/w/[workspaceId]/studio/assistants/page"));
const StudioChannelsPage = lazy(() => import("@/app/w/[workspaceId]/studio/channels/page"));
const ConnectorsPage = lazy(() => import("@/app/w/[workspaceId]/studio/connectors/page"));
const StudioIngestRulesPage = lazy(() => import("@/app/w/[workspaceId]/studio/ingest-rules/page"));
const StudioKnowledgePage = lazy(() => import("@/app/w/[workspaceId]/studio/knowledge/page"));
const ProgrammaticAccessPage = lazy(() => import("@/app/w/[workspaceId]/studio/programmatic-access/page"));
const StudioBrandPage = lazy(() => import("@/app/w/[workspaceId]/studio/brand/page"));
const StudioMiniAppsPage = lazy(() => import("@/app/w/[workspaceId]/studio/mini-apps/page"));
const WorkflowPage = lazy(() => import("@/app/w/[workspaceId]/workflow/page"));
const WorkflowDetailPage = lazy(() => import("@/app/w/[workspaceId]/workflow/[id]/page"));
const WorkflowRunDetailPage = lazy(() => import("@/app/w/[workspaceId]/workflow/[id]/runs/[runId]/page"));
const OfficePage = lazy(() => import("@/app/w/[workspaceId]/office/page"));
const NewOfficePage = lazy(() => import("@/app/w/[workspaceId]/office/new/page"));
const OfficeArtifactPage = lazy(() => import("@/app/w/[workspaceId]/office/[artifactId]/page"));
const OfficeTemplatesPage = lazy(() => import("@/app/w/[workspaceId]/office/templates/page"));
const OfficeTemplatePage = lazy(() => import("@/app/w/[workspaceId]/office/templates/[templateId]/page"));
const CrmRecordPage = lazy(() => import("@/app/w/[workspaceId]/crm/[kind]/[recordId]/page"));
const ChatPage = lazy(() => import("@/app/w/[workspaceId]/chat/page"));
const ShopifyPage = lazy(() => import("@/app/w/[workspaceId]/shopify/page"));
const CustomHomeAppPage = lazy(() => import("@/app/w/[workspaceId]/apps/[appId]/page"));
const ComputerLayout = lazy(() => import("@/app/w/[workspaceId]/computer/layout"));
const BrowsersIndexPage = lazy(() => import("@/app/w/[workspaceId]/computer/page"));
const ComputerTakeoverPage = lazy(() => import("@/app/w/[workspaceId]/computer/[sessionId]/page"));
const LivePage = lazy(() => import("@/app/w/[workspaceId]/live/page"));

const TasksSurface = lazy(async () => ({
  default: (await import("@/components/tasks/tasks-surface")).TasksSurface,
}));
const CrmSurface = lazy(async () => ({
  default: (await import("@/components/crm/crm-surface")).CrmSurface,
}));
const BrowserProfilesSection = lazy(async () => ({
  default: (await import("@/components/computer/browser-profiles-section")).BrowserProfilesSection,
}));
const FeedSurfaceShell = lazy(async () => ({
  default: (await import("@/components/feed/feed-surface-shell")).FeedSurfaceShell,
}));
const FeedPlan = lazy(async () => ({ default: (await import("@/components/feed/feed-plan")).FeedPlan }));
const FeedVoice = lazy(async () => ({ default: (await import("@/components/feed/feed-voice")).FeedVoice }));
const FeedInsights = lazy(async () => ({ default: (await import("@/components/feed/feed-insights")).FeedInsights }));
const FeedInspiration = lazy(async () => ({ default: (await import("@/components/feed/feed-inspiration")).FeedInspiration }));
const DraftSessionsList = lazy(async () => ({ default: (await import("@/components/feed/draft-sessions-list")).DraftSessionsList }));
const FeedConnection = lazy(async () => ({ default: (await import("@/components/feed/feed-connection")).FeedConnection }));
const FeedPolicy = lazy(async () => ({ default: (await import("@/components/feed/feed-policy")).FeedPolicy }));
const FeedSettings = lazy(async () => ({ default: (await import("@/components/feed/feed-settings")).FeedSettings }));
const FeedSettingsMembers = lazy(async () => ({ default: (await import("@/components/feed/feed-settings-members")).FeedSettingsMembers }));
const FeedLegacyDraftsPage = lazy(() => import("@/app/w/[workspaceId]/feed/drafts/page"));
const FeedLegacyInboxPage = lazy(() => import("@/app/w/[workspaceId]/feed/inbox/page"));
const FeedLegacyPostsPage = lazy(() => import("@/app/w/[workspaceId]/feed/posts/page"));
const FeedLegacyReadyPage = lazy(() => import("@/app/w/[workspaceId]/feed/ready/page"));
const FeedPlatformVoicePage = lazy(() => import("@/app/w/[workspaceId]/feed/[platform]/voice/page"));
const FeedPlatformPostsPage = lazy(() => import("@/app/w/[workspaceId]/feed/[platform]/posts/page"));
const FeedPostPage = lazy(() => import("@/app/w/[workspaceId]/feed/[platform]/posts/[sessionId]/page"));
const FeedLegacyDraftSessionPage = lazy(() => import("@/app/w/[workspaceId]/feed/[platform]/draft-sessions/[sessionId]/page"));

declare global {
  interface Window {
    __DOC_CONFIG__?: { apiUrl?: string };
  }
}

function apiBase(): string {
  return (
    new URLSearchParams(window.location.search).get("api") ||
    window.__DOC_CONFIG__?.apiUrl ||
    "http://localhost:4000"
  );
}

/**
 * Complete local route families for the shared built-in Home mini-app
 * vocabulary. Keeping this as a typed record is the drift guard: adding a new
 * `OPERATOR_APP_KEYS` entry fails the desktop build until its installed route
 * family is supplied here.
 */
const OPERATOR_ROUTE_ELEMENTS: Record<OperatorAppKey, ReactNode> = {
  page: (
    <Route key="page" element={<DocSurface />}>
      <Route path="p" element={<PageLeaf />} />
      <Route path="p/:pageId" element={<PageLeaf />} />
    </Route>
  ),
  office: (
    <Route key="office" path="office" element={<Outlet />}>
      <Route index element={<OfficePage />} />
      <Route path="new" element={<NewOfficePage />} />
      <Route path="templates" element={<OfficeTemplatesPage />} />
      <Route path="templates/:templateId" element={<OfficeTemplatePage />} />
      <Route path=":artifactId" element={<OfficeArtifactPage />} />
    </Route>
  ),
  tasks: <Route key="tasks" path="tasks" element={<TasksRoute />} />,
  crm: (
    <Route key="crm" path="crm" element={<Outlet />}>
      <Route index element={<CrmRoute />} />
      <Route path=":kind/:recordId" element={<CrmRecordPage />} />
    </Route>
  ),
  feed: (
    <Route key="feed" path="feed" element={<FeedShell />}>
      <Route index element={<FeedPlan />} />
      <Route path="voice" element={<FeedVoice scope="company" />} />
      <Route path="drafts" element={<FeedLegacyDraftsPage />} />
      <Route path="inbox" element={<FeedLegacyInboxPage />} />
      <Route path="posts" element={<FeedLegacyPostsPage />} />
      <Route path="ready" element={<FeedLegacyReadyPage />} />
      <Route path=":platform" element={<FeedPlatformGuard />}>
        <Route index element={<WorkspaceRedirect to="feed" />} />
        <Route path="voice" element={<FeedPlatformVoicePage />} />
        <Route path="insights" element={<FeedInsights />} />
        <Route path="inspiration" element={<FeedInspiration />} />
        <Route path="posts" element={<FeedPlatformPostsPage />} />
        <Route path="posts/:sessionId" element={<FeedPostPage />} />
        <Route path="draft-sessions" element={<DraftSessionsList />} />
        <Route
          path="draft-sessions/:sessionId"
          element={<FeedLegacyDraftSessionPage />}
        />
        <Route path="connection" element={<FeedConnection />} />
        <Route path="policy" element={<FeedPolicy />} />
        <Route path="settings" element={<FeedSettings />} />
        <Route path="settings/members" element={<FeedSettingsMembers />} />
      </Route>
      <Route path="*" element={<WorkspaceRedirect to="feed" />} />
    </Route>
  ),
  browsers: (
    <Route key="browsers" path="computer" element={<ComputerShell />}>
      <Route index element={<BrowsersIndexPage />} />
      <Route path="profiles" element={<BrowserProfilesRoute />} />
      <Route path=":sessionId" element={<ComputerTakeoverRoute />} />
    </Route>
  ),
  chat: <Route key="chat" path="chat" element={<ChatPage />} />,
  shopify: <Route key="shopify" path="shopify" element={<ShopifyPage />} />,
};

export function App() {
  // No SSR locale negotiation on file://; default to English (a stored pref can
  // drive this later). All three dictionaries are bundled.
  const dict = getDictionary("en");
  return (
    <ThemeProvider>
      <I18nProvider locale="en" dict={dict}>
        <HashRouter>
          <Routes>
            <Route path="/" element={<Boot />} />
            {/* Web's /teams picker maps onto Boot here so in-app
                `router.push("/teams")` (e.g. the workspace-switcher's
                Add-workspace row) lands on the picker explicitly instead
                of falling through the `*` catch-all. Boot has no
                create-workspace affordance yet — that gap is desktop-wide,
                not introduced by this alias. */}
            <Route path="/teams" element={<Boot />} />
            <Route path="/desktop/chat/:workspaceId" element={<DesktopChatRoute />} />
            {/* Layout route: WorkspaceShell (providers + persistent chrome)
                stays mounted across every `/w/[id]/*` surface change — only the
                `<Outlet/>` swaps — mirroring the Next workspace layout. */}
            <Route path="/w/:workspaceId" element={<WorkspaceShell />}>
              {/* Every shared built-in Home mini app is a local route family.
                  The typed record above is exhaustive against
                  OPERATOR_APP_KEYS, while these elements remain direct Route
                  children as required by react-router. */}
              {OPERATOR_APP_KEYS.map((app) => OPERATOR_ROUTE_ELEMENTS[app])}

              {/* Workspace-built custom mini apps share one local host route;
                  the app's own static bundle still comes from its scoped API
                  session and therefore needs connectivity when uncached. */}
              <Route path="apps/:appId/*" element={<CustomHomeAppPage />} />

              {/* Brain */}
              <Route path="brain" element={<BrainPage />} />
              <Route path="brain/skills/:skillRowId" element={<BrainSkillRoute />} />
              <Route path="brain/entry/:kind/:entryId" element={<BrainEntryReaderRoute />} />
              <Route path="brain/:entityId" element={<BrainEntityRoute />} />

              {/* Studio — its own grouped sub-nav layout wraps the sections. */}
              <Route path="studio" element={<StudioShell />}>
                <Route index element={<Navigate to="assistants" replace />} />
                <Route path="assistants" element={<StudioAssistantsPage />} />
                <Route path="channels" element={<StudioChannelsPage />} />
                <Route path="connectors" element={<ConnectorsPage />} />
                <Route path="ingest-rules" element={<StudioIngestRulesPage />} />
                <Route path="knowledge" element={<StudioKnowledgePage />} />
                <Route path="programmatic-access" element={<ProgrammaticAccessPage />} />
                <Route path="brand" element={<StudioBrandPage />} />
                <Route path="mini-apps" element={<StudioMiniAppsPage />} />
                <Route
                  path="task-rules"
                  element={<WorkspaceRedirect to="tasks?task-settings=rules" />}
                />
                {/* Legacy URL — the Next page is a server redirect to the
                    Brain's Skills view; the SPA mirrors it client-side. */}
                <Route
                  path="skills"
                  element={<WorkspaceRedirect to="brain?view=skills" />}
                />
              </Route>

              {/* Workflow */}
              <Route path="workflow" element={<WorkflowPage />} />
              <Route path="workflow/:id" element={<WorkflowDetailRoute />} />
              <Route
                path="workflow/:id/runs/:runId"
                element={<WorkflowRunRoute />}
              />

              {/* Live is primary workspace navigation rather than a
                  configurable Home mini app, but it is still locally routed. */}
              <Route path="live" element={<LivePage />} />

              {/* Approvals — on web the Next route is a 307 into the
                  doc-shell panel tab (`/p?panel=approvals`); the SPA mirrors
                  it client-side. */}
              <Route
                path="approvals"
                element={<WorkspaceRedirect to="p?panel=approvals" />}
              />

              {/* Legacy URL shims (parity with the Next server redirects). */}
              <Route path="inbox" element={<WorkspaceRedirect to="p" />} />
              <Route
                path="memories/review"
                element={<WorkspaceRedirect to="brain?pending=true" />}
              />
              {/* Legacy doc surface — on web the proxy's computeDocRedirect()
                  301s `doc?viewId=<id>` → `/p/<id>` and bare `doc` → `/p`;
                  the SPA mirrors it client-side. */}
              <Route path="doc" element={<DocLegacyRedirect />} />

              {/* Bare `/w/:id` → the doc surface; any other unknown
                  workspace sub-path lands there too (never the picker). */}
              <Route index element={<Navigate to="p" replace />} />
              <Route path="*" element={<Navigate to="p" replace />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </HashRouter>
        {/* Global dialog roots the doc components call into (confirmDialog /
            promptDialog / kind picker) — mounted as siblings, mirroring the Next
            root layout, so interactions like delete/rename don't crash. */}
        <ConfirmDialogProvider />
        <PromptDialogProvider />
        <KindPickerDialogProvider />
      </I18nProvider>
    </ThemeProvider>
  );
}

function DesktopChatRoute() {
  const { workspaceId = "" } = useParams();
  return workspaceId ? <DesktopChatWindow workspaceId={workspaceId} /> : <Navigate to="/" replace />;
}

// ── Boot / workspace picker ────────────────────────────────────

type WorkspaceRow = WorkspacePickerItem;

function Boot() {
  const navigate = useNavigate();
  const [state, setState] = useState<
    | { k: "boot" }
    | { k: "anon" }
    | { k: "ready"; workspaces: WorkspaceRow[] }
    | { k: "error"; detail: string }
  >({ k: "boot" });

  useEffect(() => {
    let cancelled = false;
    const presentWorkspaces = (workspaces: WorkspaceRow[]) => {
      if (cancelled) return;
      // Match the web root's one-workspace fast path. This is especially
      // important offline: cached identity can enter the local shell directly
      // instead of adding a picker click to every cold start.
      if (workspaces.length === 1) {
        navigate(`/w/${workspaces[0].id}`, { replace: true });
        return;
      }
      setState({ k: "ready", workspaces });
    };
    (async () => {
      // Validate/refresh in parallel with the local read. The saved shell can
      // paint immediately, while a successful live read quietly revalidates it.
      const tokenPromise = getValidAccessToken();
      const cached = parseDesktopWorkspaceRows(
        await idbGet<unknown>(DESKTOP_WORKSPACES_CACHE_KEY),
      );
      const bridge = desktopBridge();
      const hasStoredSession = Boolean(
        bridge?.getAccessToken?.() || bridge?.getRefreshToken?.(),
      );
      const usingCache = hasStoredSession && cached.length > 0;
      if (usingCache) presentWorkspaces(cached);

      const token = await tokenPromise;
      if (cancelled) return;
      if (!token) {
        // A stale safeStorage session can pass the shell's synchronous startup
        // check but fail refresh here. Clear it through the existing native
        // sign-out path so the shell restores its branded signin.html landing.
        if (desktopSignOut()) return;
        if (!usingCache) setState({ k: "anon" });
        return;
      }
      try {
        const res = await authFetch(`${apiBase()}/api/workspaces`);
        const data: unknown = res.ok ? await res.json() : null;
        if (cancelled) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const workspaces = parseDesktopWorkspaceRows(data);
        presentWorkspaces(workspaces);
        void idbSet(DESKTOP_WORKSPACES_CACHE_KEY, workspaces);
      } catch (e) {
        if (!cancelled && !usingCache) {
          setState({ k: "error", detail: e instanceof Error ? e.message : String(e) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  return (
    <div style={shell}>
      <div style={{ width: 520, padding: 32 }}>
        <h1 style={{ fontSize: 18, margin: "0 0 16px" }}>Use Brian</h1>
        {state.k === "boot" && <p style={dim}>Loading…</p>}
        {state.k === "anon" && (
          <button type="button" style={button} onClick={() => window.sidanclawDesktop?.signIn?.()}>
            Sign In
          </button>
        )}
        {state.k === "error" && <p style={dim}>Error: {state.detail}</p>}
        {state.k === "ready" && usesScalableWorkspacePicker(state.workspaces.length) && (
          <WorkspacePicker
            initialWorkspaces={state.workspaces}
            next="/p"
            apiUrl={apiBase()}
          />
        )}
        {state.k === "ready" && !usesScalableWorkspacePicker(state.workspaces.length) && (
          <ul style={{ padding: 0, listStyle: "none", margin: 0 }}>
            {state.workspaces.map((w) => (
              <li key={w.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/w/${w.id}/p`)}
                  style={{ ...listButton }}
                >
                  <span style={{ fontWeight: 600 }}>{w.name}</span>
                  <span style={{ opacity: 0.5, marginLeft: 8, fontSize: 12 }}>open →</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Workspace shell + surface routes ──────────────────────────

/** Inert route leaf (mirrors Next's `[pageId]/page.tsx`): keeps each path a valid
 *  route while the persistent `DocShell` owns the centre pane. */
function PageLeaf() {
  return null;
}

/** Fallback for the surface `<Suspense>` while a reused Next page resolves its
 *  `use(params)` microtask (or genuinely-async data). Fills the chrome's content
 *  area; usually invisible since the params promise settles on the next tick. */
function SurfaceFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
      Loading…
    </div>
  );
}

/**
 * Per-workspace shell: loads the workspace identity, mounts the same providers
 * the Next `w/[id]/layout.tsx` does, and renders the persistent `WorkspaceChrome`
 * around an `<Outlet/>` — the surface slot. Stays mounted across surface
 * switches (only the Outlet swaps), so the sidebar/chrome never remounts.
 */
function WorkspaceShell() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const [ctx, setCtx] = useState<
    | { k: "loading" }
    | { k: "ready"; value: WorkspaceContextValue }
    | { k: "error"; detail: string }
  >({ k: "loading" });

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    (async () => {
      const cached = parseDesktopWorkspaceContext(
        workspaceId,
        await idbGet<unknown>(desktopWorkspaceCacheKey(workspaceId)),
      );
      if (!cancelled && cached) {
        setCtx({ k: "ready", value: cached });
      }
      try {
        const res = await authFetch(`${apiBase()}/api/workspaces/${workspaceId}`);
        if (!res.ok) throw new Error(`workspace HTTP ${res.status}`);
        const team = await res.json() as unknown;
        const value = parseDesktopWorkspaceContext(workspaceId, team);
        if (!value) throw new Error("workspace response invalid");
        if (cancelled) return;
        setCtx({ k: "ready", value });
        void idbSet(desktopWorkspaceCacheKey(workspaceId), value);
      } catch (e) {
        if (!cancelled && !cached) {
          setCtx({ k: "error", detail: e instanceof Error ? e.message : String(e) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  if (!workspaceId) return <Navigate to="/" replace />;
  if (ctx.k === "loading") return <div style={shell}><p style={dim}>Loading workspace…</p></div>;
  if (ctx.k === "error") return <div style={shell}><p style={dim}>Error: {ctx.detail}</p></div>;

  // Mirrors the Next layouts: w/[id]/layout (providers + WorkspaceChrome) wrapping
  // the active surface (the Outlet) — the doc page shell on `/p`, or a folded-in
  // surface (Brain / Studio / Workflow / …) on its own route.
  return (
    <WorkspaceContextProvider value={ctx.value} apiUrl={apiBase()}>
      <CustomThemesProvider workspaceId={workspaceId}>
        <div className="flex h-screen w-full overflow-hidden bg-background">
          {/* Mirrors the Next workspace layout: one primary-assistant
              resolution shared by the chat dock and the doc surface. */}
          <PrimaryAssistantProvider workspaceId={workspaceId}>
          <DocSidebarDataProvider workspaceId={workspaceId}>
            <BrainSurfaceProvider workspaceId={workspaceId}>
              <WorkspaceChrome workspaceId={workspaceId}>
                {/* Suspense boundary for the surface slot. The reused Next
                    pages read their route params with `use(props.params)`
                    (DocSurface and the Brain/Workflow `*Route` adapters), and
                    `use()` on the resolved-promise we hand them suspends for one
                    microtask on first render. Next's App Router wraps every
                    layout/page in a boundary automatically; the SPA must supply
                    its own. Without it, entering ANY workspace surface suspends
                    to the root with no fallback and unmounts the whole tree
                    (React #482 — "suspended while responding to synchronous
                    input"), which read as the blank "Use Brian" window. */}
                <Suspense fallback={<SurfaceFallback />}>
                  <Outlet />
                </Suspense>
              </WorkspaceChrome>
            </BrainSurfaceProvider>
          </DocSidebarDataProvider>
          </PrimaryAssistantProvider>
        </div>
      </CustomThemesProvider>
    </WorkspaceContextProvider>
  );
}

/**
 * Doc surface — mirrors Next's `p/layout.tsx`: the assistant gate + persistent
 * `DocShell`. The inner `<Outlet/>` is the inert `p` / `p/:pageId` leaf; the
 * shell reads the active page id off the path. Reusing `DocSurfaceLayout` keeps
 * the gate logic identical to the web build.
 */
function DocSurface() {
  const { workspaceId = "" } = useParams<{ workspaceId: string }>();
  const params = useMemo(() => Promise.resolve({ workspaceId }), [workspaceId]);
  return (
    <DocSurfaceLayout params={params}>
      <Outlet />
    </DocSurfaceLayout>
  );
}

/** Tasks operator surface — the SPA analogue of `tasks/page.tsx`. */
function TasksRoute() {
  const { workspaceId = "" } = useParams<{ workspaceId: string }>();
  return <TasksSurface workspaceId={workspaceId} />;
}

/** CRM operator surface — the SPA analogue of `crm/page.tsx`. */
function CrmRoute() {
  const { workspaceId = "" } = useParams<{ workspaceId: string }>();
  return <CrmSurface workspaceId={workspaceId} />;
}

/** Browsers route family — mirrors `computer/layout.tsx` around local leaves. */
function ComputerShell() {
  return (
    <ComputerLayout>
      <Outlet />
    </ComputerLayout>
  );
}

/** Client analogue of the Next async profiles page's search-param unwrap. */
function BrowserProfilesRoute() {
  const location = useLocation();
  const search = useMemo(() => new URLSearchParams(location.search), [location.search]);
  return (
    <div className="h-full overflow-y-auto px-3 py-4 sm:px-4 sm:py-5 lg:px-5">
      <BrowserProfilesSection
        selectedProfileId={search.get("profile") ?? undefined}
        creating={search.get("new") === "1"}
      />
    </div>
  );
}

/** Promise-param adapter for the Next browser take-over page. */
function ComputerTakeoverRoute() {
  const { workspaceId = "", sessionId = "" } = useParams<{
    workspaceId: string;
    sessionId: string;
  }>();
  const params = useMemo(
    () => Promise.resolve({ workspaceId, sessionId }),
    [workspaceId, sessionId],
  );
  return <ComputerTakeoverPage params={params} />;
}

/** Studio surface — its grouped sub-nav layout wraps the section `<Outlet/>`. */
function StudioShell() {
  return (
    <StudioLayout>
      <Outlet />
    </StudioLayout>
  );
}

/**
 * Feed surface — the SPA analogue of `feed/layout.tsx`: OSS builds bounce to
 * the doc surface (the Next layout 404s), hosted builds mount the
 * `FeedSurfaceShell` (profiles context + readiness gate + the feed tuning
 * dock) around the section `<Outlet/>`.
 */
function FeedShell() {
  const { workspaceId = "" } = useParams<{ workspaceId: string }>();
  if (isOssEdition()) return <Navigate to={`/w/${workspaceId}/p`} replace />;
  return (
    <FeedSurfaceShell workspaceId={workspaceId}>
      <Outlet />
    </FeedSurfaceShell>
  );
}

/**
 * Platform guard — the SPA analogue of `feed/[platform]/layout.tsx`: a junk
 * `:platform` segment lands on the feed index instead of rendering a page
 * that would fetch with a garbage platform id.
 */
function FeedPlatformGuard() {
  const { workspaceId = "", platform = "" } = useParams<{
    workspaceId: string;
    platform: string;
  }>();
  if (!isFeedPlatform(platform)) {
    return <Navigate to={`/w/${workspaceId}/feed`} replace />;
  }
  return <Outlet />;
}

// ── Dynamic-segment adapters ──────────────────────────────────
// The Next pages take a `params: Promise<…>` prop (`use(params)`). Read the
// react-router params and hand each page a memoized resolved promise so its
// `use()` returns synchronously and never re-suspends on re-render.

function BrainEntityRoute() {
  const { workspaceId = "", entityId = "" } = useParams<{
    workspaceId: string;
    entityId: string;
  }>();
  const params = useMemo(
    () => Promise.resolve({ workspaceId, entityId }),
    [workspaceId, entityId],
  );
  return <BrainEntityPage params={params} />;
}

function BrainSkillRoute() {
  const { skillRowId = "" } = useParams<{ skillRowId: string }>();
  const params = useMemo(() => Promise.resolve({ skillRowId }), [skillRowId]);
  return <BrainSkillEditorPage params={params} />;
}

function BrainEntryReaderRoute() {
  const { kind = "", entryId = "" } = useParams<{ kind: string; entryId: string }>();
  const params = useMemo(
    () => Promise.resolve({ kind, id: entryId }),
    [kind, entryId],
  );
  return <BrainEntryReaderPage params={params} />;
}

function WorkflowDetailRoute() {
  const { workspaceId = "", id = "" } = useParams<{ workspaceId: string; id: string }>();
  const params = useMemo(
    () => Promise.resolve({ workspaceId, id }),
    [workspaceId, id],
  );
  return <WorkflowDetailPage params={params} />;
}

function WorkflowRunRoute() {
  const { workspaceId = "", id = "", runId = "" } = useParams<{
    workspaceId: string;
    id: string;
    runId: string;
  }>();
  const params = useMemo(
    () => Promise.resolve({ workspaceId, id, runId }),
    [workspaceId, id, runId],
  );
  return <WorkflowRunDetailPage params={params} />;
}

/** Legacy URL shim — `<Navigate>` to a workspace-scoped path (the SPA analogue
 *  of the Next server `redirect()` route leaves for `/inbox`, `/memories/review`). */
function WorkspaceRedirect({ to }: { to: string }) {
  const { workspaceId = "" } = useParams<{ workspaceId: string }>();
  return <Navigate to={`/w/${workspaceId}/${to}`} replace />;
}

/** Legacy doc-surface shim — the SPA analogue of the proxy's
 *  `computeDocRedirect()` (`lib/doc-redirect.ts`): `doc?viewId=<id>` →
 *  `/p/<id>`, bare `doc` → `/p`. Any non-`viewId` query params and the hash
 *  are carried over, matching the web redirect semantics. */
function DocLegacyRedirect() {
  const { workspaceId = "" } = useParams<{ workspaceId: string }>();
  const location = useLocation();
  const search = new URLSearchParams(location.search);
  const viewId = search.get("viewId");
  search.delete("viewId");
  const rest = search.toString();
  return (
    <Navigate
      to={{
        pathname: viewId
          ? `/w/${workspaceId}/p/${viewId}`
          : `/w/${workspaceId}/p`,
        search: rest ? `?${rest}` : "",
        hash: location.hash,
      }}
      replace
    />
  );
}

const shell: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  background: "#0b1020",
  color: "#e9e9e7",
};
const dim: React.CSSProperties = { opacity: 0.6, fontSize: 13 };
const button: React.CSSProperties = {
  font: "inherit",
  fontWeight: 600,
  letterSpacing: "0.01em",
  // Fancy primary treatment matching signin.html's landing CTA: cyan-family
  // gradient + glassy inset sheen + layered cyan glow (the app's --btn-image /
  // --btn-glow recipe), not a flat Notion-blue fill.
  color: "#04131c",
  background: "linear-gradient(135deg, #5fe2ff 0%, #34d3ff 48%, #17bdec 100%)",
  border: 0,
  borderRadius: 12,
  padding: "12px 30px",
  cursor: "pointer",
  boxShadow:
    "inset 0 1px 0 rgba(255,255,255,0.45), 0 1px 2px rgba(4,19,28,0.18), 0 8px 20px -8px rgba(52,211,255,0.55), 0 16px 40px -16px rgba(52,211,255,0.45)",
};
const listButton: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "10px 0",
  borderTop: "1px solid rgba(127,127,127,0.18)",
  background: "transparent",
  color: "inherit",
  border: 0,
  borderTopStyle: "solid",
  cursor: "pointer",
  fontSize: 14,
};
