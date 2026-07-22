/**
 * Per-turn injector that adds doc tools to a chat turn's tool map for any
 * assistant authoring on the doc SURFACE (`docSurface: true`) — the
 * workspace primary by default. Doc is a skill, not an app type.
 *
 * Injects twenty-two tools:
 *
 *   - 10 doc page tools (`packages/core/src/doc/tools.ts`):
 *     `renderPage` / `patchPage` / `getBlock` / `queryDataBlock` /
 *     `getCurrentPage` / `getSection` / `getBlockRange` / `createSubPage` /
 *     `exportPage` / `importToPage` (the doc-format-conversion tools).
 *     `patchPage` writes through the live-doc gateway (Yjs) when
 *     `DOC_SYNC_URL`/`SECRET` are set; `getSection` / `getBlockRange` expand
 *     sections the large-page map collapsed (doc turn-context optimization).
 *   - 9 entity tools (`packages/core/src/entities/doc-tools.ts`):
 *     `listEntityTypes` / `createEntityType` / `addProperty` / `removeProperty`
 *     / `renameProperty` / `createEntity` / `updateEntity` / `deleteEntity` /
 *     `queryEntities`.
 *   - 3 comment tools (`packages/core/src/doc/comment-tools.ts`):
 *     `postComment` / `resolveComment` / `getCommentThread` — block-anchored
 *     comment threads (chat-as-threads), the last reading one thread's
 *     conversation on demand for in-page thread discovery.
 *     See `docs/architecture/features/doc-comments.md`.
 *   - 1 CONDITIONAL theme tool (`./theme-tools.ts`): `refineActiveTheme` —
 *     injected ONLY when the client passes `activeThemeId` (the user's applied
 *     custom theme) + a provider, so "make my theme warmer" works from chat.
 *     See `docs/architecture/features/doc-custom-themes.md`.
 *   - 1 CONDITIONAL icon tool (`./site-icon-tool.ts`): `fetchSiteIcon` —
 *     injected only when a `FilesApi` is wired; fetches a site's real
 *     logo/favicon (SSRF-guarded) and stores it as an `img:` page-icon token
 *     for `patchPage setIcon`. See `docs/architecture/features/doc.md` →
 *     "Image icons".
 *
 * Stores: instantiated lazily via the DB-backed factories (Agent P1C —
 * `db/doc-page-store.ts`, `db/doc-entity-store.ts`,
 * `db/saved-views-store.ts`, `db/tasks-store.ts`, `db/crm-store.ts`,
 * `db/workflow-store.ts`). Callers may inject pre-built stores via opts
 * to share instances with the rest of the chat route — when omitted, the
 * factories are called once and the result cached at module scope so we
 * never build the same store twice across turns.
 *
 * The `WorkspaceDirectoryStore` projection is built locally over
 * `createWorkspaceStore()`, mirroring the adapter in
 * `apps/api/src/index.ts`. Future Phase 5 cleanup may promote the
 * projection to a shared `db/workspace-directory-store.ts` factory.
 *
 * `onOpApplied` — per-op observer for SSE streaming (Lock #7). The chat
 * route plumbs this through; if absent the patch still applies but no
 * intermediate SSE events emit. See `docs/plans/doc-v1-execution.md`
 * §5.3 and `core/src/doc/tools.ts` → `DocOpObserver`.
 *
 * `renderView` cutover — DONE. The global `renderView` tool is now removed
 * from the doc surface: after merging the doc tools into the per-turn
 * map we `delete('renderView')` (see the end of `injectDocTools`). The
 * reason is that `renderView` writes the frozen `saved_views.page` column,
 * which the doc live editor never reads — it reads the Yjs doc — so any
 * data view authored via `renderView` would be invisible on doc. Doc
 * assistants author data views via `renderPage` / `patchPage`, which route to
 * the live Yjs doc through the `DocGateway`. `renderView` remains a
 * global tool for NON-doc surfaces (standard chat, `apps/web`, the
 * "+ New draft" flow) where there is no live Yjs doc and `saved_views.page`
 * IS the correct target. See `docs/architecture/features/doc.md`.
 */

import type {
  DocGateway,
  DocEntityStore,
  DocOpObserver,
  DocToolEvent,
  DocToolEventContext,
  DocPageStore,
  FilesApi,
  FileStore,
  CommentThreadStore,
  CrmStore,
  LLMProvider,
  SavedViewStore,
  TaskStore,
  Tool,
  WorkflowRunStore,
  WorkspaceDirectoryStore,
  WorkspaceMemberInfo,
} from '@use-brian/core'
import type { CustomThemePayload } from '@use-brian/shared'
import {
  createDocEntityTools,
  createDocTools,
  createPostCommentTool,
  createResolveCommentTool,
  createGetCommentThreadTool,
  createIngestPageTool,
  listBuiltInEntityTypes,
} from '@use-brian/core'
import { createDbDocEntityStore } from '../db/doc-entity-store.js'
import { createDbDocPageStore } from '../db/doc-page-store.js'
import { createDbDocThemesStore, type DocThemeStore } from '../db/doc-themes-store.js'
import { createDbCommentThreadStore } from '../db/comment-thread-store.js'
import { createRefineActiveThemeTool } from './theme-tools.js'
import { createFetchSiteIconTool } from './site-icon-tool.js'
import { createDbCrmStore } from '../db/crm-store.js'
import { createDbSavedViewStore } from '../db/saved-views-store.js'
import { publishPageLifecycle } from '../page-event-fanout.js'
import { createDbTaskStore } from '../db/tasks-store.js'
import { createDbWorkflowRunStore } from '../db/workflow-store.js'
import { createWorkspaceStore } from '../db/workspace-store.js'
import { createDocGateway } from './doc-gateway.js'

export type InjectDocToolsOptions = {
  tools: Map<string, Tool>
  userId: string
  assistant: {
    id: string
    kind: 'standard' | 'app' | 'primary'
    /** Set iff kind='app' (only 'distribution' remains). Not used to gate doc
     *  injection — that's `docSurface`. */
    appType?: 'distribution' | null
    /** Workspace the assistant operates over (required for any injection). */
    workspaceId?: string | null
  }
  /**
   * Doc SURFACE injection. Set true when the turn originates on the doc
   * surface (`session.appOrigin='doc'`) — the workspace primary by default,
   * or any assistant the user switched to — OR on an app-web workspace
   * surface (`isAppSurface` in chat.ts: brain / studio / workflow /
   * approvals / knowledge-base), where the tools ride AMBIENTLY (the chat
   * route pairs them with the weak `buildAmbientDocSkillBlock` steering
   * instead of the page-first protocol). This is the ONLY gate for doc
   * tools (doc is a skill, not an app type): when true, the doc tools
   * inject onto that host assistant so it can author the page in the same loop
   * it did the work in. `workspaceId` is still required.
   */
  docSurface?: boolean
  /**
   * Per-turn doc-page anchor. When the chat originates from
   * `apps/app-web` with a page already open, the chat route passes
   * the active `pageId` plus its current `expectedVersion` here. The
   * outline is built alongside this (in `chat.ts`) and delivered via the
   * turn-context envelope so the model can address blocks by id. The
   * `expectedVersion` rides through to the future `patchPage` tool
   * deps for CAS validation. Both null when the turn is doc-mode
   * but no page is open (e.g. the model is about to call `renderPage`
   * to create a fresh one).
   */
  pageId?: string | null
  expectedVersion?: number | null
  /**
   * The custom theme the user CURRENTLY HAS APPLIED, passed from the doc
   * client (a per-user `localStorage` value the server can't otherwise know).
   * When present (+ a `provider`), the `refineActiveTheme` tool is injected so
   * the user can iterate on their theme from chat ("make my theme warmer").
   * Absent on built-in palettes → the tool isn't injected (tool-awareness rule).
   */
  activeThemeId?: string | null
  /** Provider for `refineActiveTheme`'s seed-adjustment call. */
  provider?: LLMProvider
  /** Servable background-lane model, resolved by the caller against the
   * configured providers. Forwarded to the theme tool's LLM call. */
  backgroundModel?: string
  /** Themes store for `refineActiveTheme`; falls back to the lazy singleton. */
  docThemesStore?: DocThemeStore
  /** Fired after a chat-driven theme refine so the route can stream the new
   *  tokens to the client (the `doc_theme_update` SSE → live apply). */
  onThemeRefined?: (themeId: string, tokens: CustomThemePayload, appearance: 'light' | 'dark') => void
  /**
   * Optional shared stores. When absent, lazily-cached module-level
   * DB-backed factories are used so the same singleton is reused across
   * turns. The injection path is identical either way; callers pass these
   * when they want to share allocator-level instances with the rest of the
   * chat route (e.g. to share an `EntityLinksStore` with `TaskStore`).
   */
  docPageStore?: DocPageStore
  docEntityStore?: DocEntityStore
  /** Cached-file store for `importToPage` (the faithful AI import). The chat
   *  route passes its own `fileStore`; absent → `importToPage` reports it's
   *  unavailable (the page tools otherwise work). */
  fileStore?: FileStore
  /** Comment-thread store for the `postComment` / `resolveComment` tools.
   *  Falls back to the lazily-cached DB-backed singleton when omitted. */
  commentThreadStore?: CommentThreadStore
  /**
   * Doc-page → brain distillation runner (the "Sync to brain" pipeline). When
   * provided, the `ingestPage` chat tool is injected so the assistant can ingest
   * a page on request. Absent (minimal / open build with no Pipeline B) → the
   * tool isn't injected (tool-awareness rule). RLS-scoped to the caller.
   */
  ingestPage?: (args: { userId: string; pageId: string }) => Promise<void>
  /**
   * Workspace files API — backs the `fetchSiteIcon` tool (fetch a site's
   * real logo → store as a workspace file → `img:` page-icon token). When
   * absent (misconfigured deploy with no file storage) the tool isn't
   * injected (tool-awareness rule), mirroring `ingestPage`.
   */
  filesApi?: FilesApi
  /**
   * Optional live-doc gateway. When omitted, resolved from
   * `DOC_SYNC_URL`/`DOC_SYNC_SECRET` env; when those are absent the
   * gateway is `undefined` and `patchPage` falls back to the legacy CAS
   * path. Tests inject a fake.
   */
  docGateway?: DocGateway
  savedViewStore?: SavedViewStore
  taskStore?: TaskStore
  crmStore?: CrmStore
  workflowRunStore?: WorkflowRunStore
  workspaceDirectory?: WorkspaceDirectoryStore
  /**
   * Per-op observer for `patchPage`'s SSE-per-op streaming (Lock #7).
   * The chat route subscribes here and forwards one SSE event per applied
   * op. Absent in smoke / worker / scheduled-job contexts where SSE has
   * no transport.
   */
  onOpApplied?: DocOpObserver
  /**
   * Optional analytics/notification hook for the doc tool events
   * (`page_rendered` / `page_patched` / …). The chat route uses it to learn
   * which page(s) the AI wrote this turn so the post-turn auto-title pass
   * (migration 218) knows what to consider. Absent in smoke / worker
   * contexts.
   */
  onEvent?: (event: DocToolEvent, ctx: DocToolEventContext) => void
}

export type InjectDocToolsResult = {
  injected: boolean
  injectedCount: number
}

// ── Lazy module-level singletons ──────────────────────────────────────
//
// The DB-backed stores are stateless and safe to share across turns. We
// build each on first use rather than at module load so importing this
// file from a smoke test doesn't force a DB-pool connection during
// type-check / test bootstrap.

let cachedDocPageStore: DocPageStore | undefined
let cachedDocEntityStore: DocEntityStore | undefined
let cachedCommentThreadStore: CommentThreadStore | undefined
let cachedSavedViewStore: SavedViewStore | undefined
let cachedTaskStore: TaskStore | undefined
let cachedCrmStore: CrmStore | undefined
let cachedWorkflowRunStore: WorkflowRunStore | undefined
let cachedWorkspaceDirectory: WorkspaceDirectoryStore | undefined
let cachedDocThemesStore: DocThemeStore | undefined

function defaultWorkspaceDirectory(): WorkspaceDirectoryStore {
  // Mirrors the adapter in `apps/api/src/index.ts`. Keeps inject.ts
  // self-contained so the chat route doesn't have to plumb yet another
  // store through — when chat.ts grows a typed `workspaceDirectory` slot
  // (or this projection moves into `db/`) the fallback becomes dead code
  // and the explicit injection takes over.
  const workspaceStore = createWorkspaceStore()
  const directory: WorkspaceDirectoryStore = {
    async listMembers(userId, workspaceId) {
      const membership = await workspaceStore.getMembership(userId, workspaceId)
      if (!membership) return []
      const members = await workspaceStore.listMembers(userId, workspaceId)
      return members.map((m) => ({
        memberId: m.id,
        name: m.userName ?? null,
        email: m.email ?? null,
        avatarUrl: m.avatarUrl ?? null,
        role: m.role,
      }))
    },
    async get(workspaceId, memberId) {
      const map = await directory.batchGet(workspaceId, [memberId])
      return map.get(memberId) ?? null
    },
    async batchGet(workspaceId, memberIds) {
      if (memberIds.length === 0) return new Map<string, WorkspaceMemberInfo>()
      // Empty userId because the doc surface trusts the workspace
      // boundary already enforced by RLS on the caller's queries; this
      // batch read is treated as system-bypass. Mirrors the pattern
      // used in `apps/api/src/index.ts`.
      const members = await workspaceStore.listMembers('', workspaceId)
      const requested = new Set(memberIds)
      const out = new Map<string, WorkspaceMemberInfo>()
      for (const m of members) {
        if (!requested.has(m.id)) continue
        out.set(m.id, {
          memberId: m.id,
          name: m.userName ?? null,
          email: m.email ?? null,
          avatarUrl: m.avatarUrl ?? null,
          role: m.role,
        })
      }
      return out
    },
  }
  return directory
}

/**
 * Build all 20 doc tools and inject them into the chat tool registry.
 * Gated upstream in `chat.ts` on `isDocSurface(session)` — any assistant on
 * the doc surface (`docSurface: true`).
 */
export async function injectDocTools(
  options: InjectDocToolsOptions,
): Promise<InjectDocToolsResult> {
  // Belt-and-braces gate. Doc authoring is a skill, injected only on the
  // doc SURFACE (`docSurface: true`) — onto whatever assistant is talking
  // there, the workspace primary by default. The chat route decides via
  // `isDocSurface(session)`; this gate is the safety net so a stray
  // off-surface caller still no-ops cleanly rather than minting tools that have
  // no business there.
  if (options.docSurface !== true) {
    return { injected: false, injectedCount: 0 }
  }

  const workspaceId = options.assistant.workspaceId
  if (!workspaceId) {
    // A doc-app assistant without a workspace is misconfigured. The
    // tool factories themselves gate every call on `context.workspaceId`
    // and return a structured error, but for the inject path we surface
    // a clean no-op so the model sees no doc tools at all rather than
    // tools that always error. Mirrors feed/inject which returns
    // `injected: false` when required deps are absent.
    return { injected: false, injectedCount: 0 }
  }

  // Resolve stores: prefer caller-supplied, fall back to the lazily-
  // cached singletons. Production hits the cached fallback in every
  // call; tests pass mocks explicitly.
  const docPageStore =
    options.docPageStore ??
    (cachedDocPageStore ??= createDbDocPageStore())
  const docEntityStore =
    options.docEntityStore ??
    (cachedDocEntityStore ??= createDbDocEntityStore())
  // The cached fallback MUST carry the page-lifecycle hook: the interactive
  // chat route injects doc tools without supplying a store, so an assistant's
  // createSubPage / patchPage / renderPage write reaches the DB through this
  // singleton. Without the hook those `system` writes emit no page event and a
  // `page`-source workflow never fires (the empty PageWorkflowRuns chip — most
  // visible in single-player OSS where the assistant authors most pages). The
  // hook is a no-op until `bootOpenApi` binds the dispatcher and best-effort
  // thereafter, so it is safe on every fallback consumer. See
  // docs/architecture/features/workflow.md → "Page event source".
  const savedViewStore =
    options.savedViewStore ??
    (cachedSavedViewStore ??= createDbSavedViewStore({
      onPageLifecycle: publishPageLifecycle,
    }))
  const taskStore =
    options.taskStore ?? (cachedTaskStore ??= createDbTaskStore())
  const crmStore = options.crmStore ?? (cachedCrmStore ??= createDbCrmStore())
  const workflowRunStore =
    options.workflowRunStore ??
    (cachedWorkflowRunStore ??= createDbWorkflowRunStore())
  const workspaceDirectory =
    options.workspaceDirectory ??
    (cachedWorkspaceDirectory ??= defaultWorkspaceDirectory())
  const commentThreadStore =
    options.commentThreadStore ??
    (cachedCommentThreadStore ??= createDbCommentThreadStore())

  // Build the 10 doc page tools. The dep bag matches `DocToolDeps`
  // in `packages/core/src/doc/tools.ts`.
  // Live-doc gateway: when DOC_SYNC_URL/SECRET are configured, `patchPage`
  // routes ops to the collaborative Y.Doc (humans see AI edits live) instead
  // of the legacy `saved_views.page` CAS. Undefined → CAS fallback.
  const docGateway =
    options.docGateway ?? createDocGateway()

  const pageTools = createDocTools({
    savedViewStore,
    docPageStore,
    docGateway,
    taskStore,
    crmStore,
    workflowRunStore,
    workspaceDirectory,
    onOpApplied: options.onOpApplied,
    onEvent: options.onEvent,
    // Pin patchPage to the page the user is looking at; allow same-turn-created
    // pages (renderPage / createSubPage register themselves in this set).
    anchorPageId: options.pageId ?? null,
    turnCreatedPageIds: new Set<string>(),
    // Cached-file store for `importToPage` (faithful AI import).
    fileStore: options.fileStore,
  })

  // Build the 9 entity tools. Built-ins come from `listBuiltInEntityTypes`
  // exported by the core barrel — injected (rather than statically
  // imported by the tool factory) so tests can pin a fixed roster.
  const entityTools = createDocEntityTools({
    store: docEntityStore,
    workspaceId,
    currentUserId: options.userId,
    listBuiltInEntityTypes,
  })

  // Comment tools (chat-as-threads). `postComment` lets the model annotate
  // uncertainties in-context (render-first; see soul.ts); `resolveComment`
  // closes a thread. Both are block-anchored DB writes — they never touch
  // the Yjs doc.
  const postComment = createPostCommentTool({ commentThreadStore })
  const resolveComment = createResolveCommentTool({ commentThreadStore })
  // Read one thread's conversation on demand — the "details" half of in-page
  // thread discovery (the index is injected into the prompt by the chat route).
  const getCommentThread = createGetCommentThreadTool({ commentThreadStore })

  // Push every tool into the chat session's registry. Order isn't
  // load-bearing — the model sees the registry as a flat name→Tool map.
  const allTools: Tool[] = [
    pageTools.renderPage,
    pageTools.patchPage,
    pageTools.getBlock,
    pageTools.queryDataBlock,
    pageTools.getCurrentPage,
    pageTools.getSection,
    pageTools.getBlockRange,
    pageTools.createSubPage,
    pageTools.exportPage,
    pageTools.importToPage,
    entityTools.listEntityTypes,
    entityTools.createEntityType,
    entityTools.addProperty,
    entityTools.removeProperty,
    entityTools.renameProperty,
    entityTools.createEntity,
    entityTools.updateEntity,
    entityTools.deleteEntity,
    entityTools.queryEntities,
    postComment,
    resolveComment,
    getCommentThread,
  ]

  // `ingestPage` (doc-page → brain distillation) — injected ONLY when the
  // runner is wired (Pipeline B present). Off in minimal/open builds so the
  // model never sees a tool that can't run (tool-awareness rule). Anchored to
  // the open page so "add this page to the brain" needs no explicit id.
  if (options.ingestPage) {
    allTools.push(
      createIngestPageTool({
        ingestPage: options.ingestPage,
        anchorPageId: options.pageId ?? null,
      }),
    )
  }

  // `fetchSiteIcon` (site logo → stored image → `img:` page-icon token for
  // `patchPage setIcon`) — injected only when a `FilesApi` is wired, so the
  // model never sees a tool whose storage half can't run (tool-awareness
  // rule). See docs/architecture/features/doc.md → "Image icons".
  if (options.filesApi) {
    allTools.push(
      createFetchSiteIconTool({
        filesApi: options.filesApi,
        workspaceId,
      }),
    )
  }

  for (const tool of allTools) {
    options.tools.set(tool.name, tool)
  }

  // Conversational theme iteration (refine-only). Injected ONLY when the doc
  // client sent the user's currently-applied custom theme id as turn context
  // AND a provider is available — so "make my theme warmer" works in chat, but
  // the tool is absent on built-in palettes (kept off the system prompt, per
  // the tool-awareness rule). See docs/architecture/features/doc-custom-themes.md.
  let themeToolInjected = false
  if (options.activeThemeId && options.provider) {
    const refineActiveTheme = createRefineActiveThemeTool({
      themeId: options.activeThemeId,
      provider: options.provider,
      model: options.backgroundModel,
      store:
        options.docThemesStore ?? (cachedDocThemesStore ??= createDbDocThemesStore()),
      onRefined: options.onThemeRefined,
    })
    options.tools.set(refineActiveTheme.name, refineActiveTheme)
    themeToolInjected = true
  }

  // Remove the global `renderView` tool from the doc surface. It is
  // registered once at boot (`apps/api/src/index.ts`) and lands in the
  // per-turn `options.tools` map for every assistant, including doc.
  // But `renderView` writes the frozen `saved_views.page` column as a
  // standalone legacy view row the doc live editor never reads — it renders
  // the Yjs doc — so a data view authored via `renderView` would be invisible
  // on doc. Doc assistants author via `patchPage` (whose ops route to the
  // live Yjs doc through the `DocGateway`) and `renderPage` (which
  // persists the new page to `saved_views.page`; `apps/doc-sync` seeds that
  // block JSON into the Yjs doc on first open — see `persistence.ts`
  // `loadPageUpdate`). This delete rides wherever the doc tools ride: the
  // doc surface AND the app-web workspace surfaces (ambient injection) —
  // one authoring path per app-web turn. Surfaces with no doc tools at all
  // (apps/web standard chat, Telegram/Slack) keep `renderView`.
  options.tools.delete('renderView')

  // `injectedCount` counts the doc tools merged into the map (the length
  // of `allTools`), NOT the post-delete map size — deleting the global
  // `renderView` here doesn't change how many doc tools we injected.
  return { injected: true, injectedCount: allTools.length + (themeToolInjected ? 1 : 0) }
}
