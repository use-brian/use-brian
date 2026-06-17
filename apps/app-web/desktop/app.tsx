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
 *                   Approvals, Knowledge-base — each its own child route
 *                   rendered in `WorkspaceChrome`'s `<Outlet/>` slot.
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
 * blank "sidanclaw" boot frame.
 */
import { useEffect, useMemo, useState, Suspense } from "react";
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
import { WorkspaceChrome } from "@/components/doc/workspace-chrome";

// Surface layouts + pages — reused verbatim from the Next route tree so the
// desktop SPA renders the SAME surface under each `/w/[id]/*` path and the two
// builds can't drift. (Vite resolves the bracketed `[workspaceId]` segment as a
// literal file path via the `@` alias.)
import DocSurfaceLayout from "@/app/w/[workspaceId]/p/layout";
import BrainPage from "@/app/w/[workspaceId]/brain/page";
import BrainEntityPage from "@/app/w/[workspaceId]/brain/[entityId]/page";
import BrainSkillEditorPage from "@/app/w/[workspaceId]/brain/skills/[skillRowId]/page";
import BrainEntryReaderPage from "@/app/w/[workspaceId]/brain/entry/[kind]/[id]/page";
import StudioLayout from "@/app/w/[workspaceId]/studio/layout";
import StudioAssistantsPage from "@/app/w/[workspaceId]/studio/assistants/page";
import StudioChannelsPage from "@/app/w/[workspaceId]/studio/channels/page";
import ConnectorsPage from "@/app/w/[workspaceId]/studio/connectors/page";
import StudioIngestRulesPage from "@/app/w/[workspaceId]/studio/ingest-rules/page";
import StudioKnowledgePage from "@/app/w/[workspaceId]/studio/knowledge/page";
import StudioMiniAppsPage from "@/app/w/[workspaceId]/studio/mini-apps/page";
import ProgrammaticAccessPage from "@/app/w/[workspaceId]/studio/programmatic-access/page";
import WorkflowPage from "@/app/w/[workspaceId]/workflow/page";
import WorkflowDetailPage from "@/app/w/[workspaceId]/workflow/[id]/page";
import WorkflowRunDetailPage from "@/app/w/[workspaceId]/workflow/[id]/runs/[runId]/page";
import ApprovalsPage from "@/app/w/[workspaceId]/approvals/page";
import KbGapsPage from "@/app/w/[workspaceId]/knowledge-base/gaps/page";
import KbNewStubPage from "@/app/w/[workspaceId]/knowledge-base/new/page";

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
            {/* Layout route: WorkspaceShell (providers + persistent chrome)
                stays mounted across every `/w/[id]/*` surface change — only the
                `<Outlet/>` swaps — mirroring the Next workspace layout. */}
            <Route path="/w/:workspaceId" element={<WorkspaceShell />}>
              {/* Doc surface — DocShell persists across `p` ↔ `p/:pageId`, so
                  opening a page is a soft swap (the shell reads the id off the
                  path), not a remount. Mirrors Next's `p/layout.tsx`. */}
              <Route element={<DocSurface />}>
                <Route path="p" element={<PageLeaf />} />
                <Route path="p/:pageId" element={<PageLeaf />} />
              </Route>

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
                <Route path="mini-apps" element={<StudioMiniAppsPage />} />
                <Route path="programmatic-access" element={<ProgrammaticAccessPage />} />
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

              {/* Approvals */}
              <Route path="approvals" element={<ApprovalsPage />} />

              {/* Knowledge-base */}
              <Route path="knowledge-base/gaps" element={<KbGapsPage />} />
              <Route path="knowledge-base/new" element={<KbNewStubPage />} />

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

// ── Boot / workspace picker ────────────────────────────────────

interface WorkspaceRow {
  id: string;
  name: string;
}

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
    (async () => {
      const token = await getValidAccessToken();
      if (cancelled) return;
      if (!token) return setState({ k: "anon" });
      try {
        const res = await authFetch(`${apiBase()}/api/workspaces`);
        const data: unknown = res.ok ? await res.json() : null;
        if (cancelled) return;
        if (!res.ok) return setState({ k: "error", detail: `HTTP ${res.status}` });
        const arr = Array.isArray(data)
          ? data
          : Array.isArray((data as { workspaces?: unknown[] })?.workspaces)
            ? (data as { workspaces: unknown[] }).workspaces
            : [];
        const workspaces = arr
          .map((w) => {
            const o = (w ?? {}) as Record<string, unknown>;
            const id = typeof o.id === "string" ? o.id : null;
            return id ? { id, name: typeof o.name === "string" ? o.name : id } : null;
          })
          .filter((w): w is WorkspaceRow => w !== null);
        setState({ k: "ready", workspaces });
      } catch (e) {
        if (!cancelled) setState({ k: "error", detail: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={shell}>
      <div style={{ width: 520, padding: 32 }}>
        <h1 style={{ fontSize: 18, margin: "0 0 16px" }}>sidanclaw</h1>
        {state.k === "boot" && <p style={dim}>Loading…</p>}
        {state.k === "anon" && (
          <button type="button" style={button} onClick={() => window.sidanclawDesktop?.signIn?.()}>
            Sign In
          </button>
        )}
        {state.k === "error" && <p style={dim}>Error: {state.detail}</p>}
        {state.k === "ready" && (
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
      try {
        const res = await authFetch(`${apiBase()}/api/workspaces/${workspaceId}`);
        if (!res.ok) throw new Error(`workspace HTTP ${res.status}`);
        const team = (await res.json()) as {
          name?: string;
          role?: WorkspaceContextValue["role"];
          clearance?: WorkspaceContextValue["clearance"];
          me?: { id?: string };
        };
        if (cancelled) return;
        setCtx({
          k: "ready",
          value: {
            workspaceId,
            name: team.name ?? "Workspace",
            role: team.role ?? "member",
            clearance: team.clearance ?? "internal",
            me: { id: team.me?.id ?? "" },
          },
        });
      } catch (e) {
        if (!cancelled) setCtx({ k: "error", detail: e instanceof Error ? e.message : String(e) });
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
    <WorkspaceContextProvider value={ctx.value}>
      <CustomThemesProvider workspaceId={workspaceId}>
        <div className="flex h-screen w-full overflow-hidden bg-background">
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
                    input"), which read as the blank "sidanclaw" window. */}
                <Suspense fallback={<SurfaceFallback />}>
                  <Outlet />
                </Suspense>
              </WorkspaceChrome>
            </BrainSurfaceProvider>
          </DocSidebarDataProvider>
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

/** Studio surface — its grouped sub-nav layout wraps the section `<Outlet/>`. */
function StudioShell() {
  return (
    <StudioLayout>
      <Outlet />
    </StudioLayout>
  );
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
