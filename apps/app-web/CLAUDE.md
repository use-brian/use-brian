@AGENTS.md

# apps/app-web

Standalone Notion-style page surface for doc-typed assistants. Sibling
to `apps/feed-web` — where feed-web hosts outbound distribution apps,
app-web hosts inbound research / analytics / A2UI deliverables.
Deployed to Vercel; local dev on port `3003`. The core web app
(`apps/web`) deep-links here via the page-toggle when a workspace opens
the Doc tab; app-web hosts no chat-app or assistant-config
surface, so it always punts deep config back to `apps/web`.

**Read `AGENTS.md` first** — the Next.js version pinned here has
breaking changes from the version most LLM training data describes.
Project-wide rules in the root `CLAUDE.md`.

## What this is

A three-column Notion-feel page surface scoped to one workspace:

- **Left sidebar** — Notion-fidelity rebuild, **light theme by default**,
  painted via its own `--sidebar*` tokens whose values come from the active
  **palette** (see [Theme](#theme)): the default `notion` palette is the warm
  neutral grey (`#F7F7F5` bg / `#37352F` text), and an AI-generated `custom`
  palette recolours it. Sidebar surfaces
  always read from the tokens (`bg-sidebar` / `bg-sidebar-accent` /
  `text-sidebar-foreground`) so they track whichever palette is selected; the
  active page row is the `.doc-nav-active` pill (flat grey on Notion, a
  gradient on `custom`). The sidebar is now **persistent chrome across every
  `/w/[id]/*` surface** (Brain / Studio / Workflow / Approvals / Knowledge-base /
  the doc page tree), not doc-only: it lives in `workspace-chrome.tsx`
  mounted by the workspace `layout.tsx`, with its data + page-mutation handlers
  in `doc-sidebar-data.tsx` (`DocSidebarDataProvider`). A **horizontal
  Notion-style icon toolbar** (left to right: **Home / Brain / Studio / Workflow**
  surfaces, then the **Inbox / Search** utilities) sits below the workspace
  switcher. Inbox is a toggle button that opens the **left-anchored Inbox flyout
  panel** — `inbox-panel.tsx`, owned by `WorkspaceChrome`; overlays the surface
  instead of navigating away — with an unread-count badge (see
  [`docs/architecture/features/doc-inbox.md`](../../docs/architecture/features/doc-inbox.md));
  Search toggles a client-side title filter. Every item is icon-only with a
  hover tooltip (name + ⌘ shortcut); **exactly one item at a time** expands into
  a labeled `.doc-nav-active` pill (`navItemCls`) — normally the active
  surface (`surfaceFromPathname`), but a utility takes the pill while open and
  the surface drops to a highlighted icon, so a long label can't collide with a
  second pill. Home/Brain/Studio/Workflow are soft-nav links with ⌘1/2/3/4; Studio shows
  a dismissable cold-start "Set up" nudge while the workspace has no connected
  connector. **The body below the toolbar is surface-aware** (`activeSurface`):
  on **Home** (`/p`) it's the page tree described next; on **Brain** / **Studio** /
  **Workflow** it swaps in that surface's own panel
  (`components/doc/sidebar-panels/` — Brain: filter options + grouped/graph
  toggle + unconfirmed-entries nudge, all driving the page through the
  layout-level `useBrainSurface()` context; Studio: the grouped section rail from
  `lib/studio-nav.ts`; Workflow: the workspace's workflows ranked soonest-next-run
  first via `lib/workflow-next-run.ts`); every other surface (Approvals /
  Knowledge-base / root) shows nothing. **Search is a Home-only utility** — it
  filters the page tree, so its nav item + input only appear on `/p`. On Home the
  toolbar sits
  above named sections, top-to-bottom: **Favorites** (the **saved-rooted**
  subtrees of the one
  directory tree — pages nest under pages with drag-to-reparent), and
  **Drafts** (its **draft-rooted** subtrees, the auto-prune scratch space).
  (`doc-sidebar-data.tsx` still tracks recently-visited pages in
  `localStorage` key `doc:recents:<workspaceId>`, but that now feeds only the
  home landing's "recently opened" cards, **not** a sidebar section.)
  The tree is folded from the **union** of the saved + draft lists
  (`buildTree([...saved, ...drafts])`) then split by root state, so a
  sub-page (always a draft) nests under its parent in that parent's section
  **rather than flattening to root**; both sections share the recursive
  `sidebar-tree-node.tsx`
  inside one `<DndContext>`. Search alone drops to a flat hit list. Empty
  sections render
  nothing; the old **Meetings** placeholder was removed. Every tree row's
  leading slot is an **always-available disclosure toggle** — it shows the
  page icon (the user/AI emoji from `saved_views.icon`, migration 211; `NULL`
  falls back to a type-derived lucide glyph) at rest and swaps to a chevron on
  hover / while expanded, and clicking it opens *any* page (one with no
  children yet shows a muted **"No pages inside"** caption). **There is no
  emoji picker in the sidebar** — the page icon is set from the page header
  (`PageTitle` in the centre pane, via `ui/emoji-picker.tsx`). Per-row hover
  reveals an overflow `…` menu (Rename / Duplicate / Unsave / Delete) then a
  `+` (add child page); these actions are absolutely positioned, so the title
  runs full-width at rest and truncates with an ellipsis only on hover/focus
  to clear them. A **draft** row additionally reveals an `Nd until auto-delete`
  caption on hover (or while it's the active page) — the shared
  `draft-prune-button.tsx`, which swaps to a **"Save page"** CTA on hover/focus
  and promotes the draft into Favorites in one click. When the AI files a sub-page (`createSubPage`), a
  `sub_page_created` SSE → `doc:draft-created` reload surfaces the new child
  live (no manual refresh). See
  [`docs/architecture/features/doc.md`](../../docs/architecture/features/doc.md)
  → "Nested pages" and "Layout".
- **Centre pane** — active page renderer, topped by a **two-row top bar**:
  the upper **top layer** (`doc-topbar.tsx` — sidebar collapse toggle,
  browse-history `‹›` arrows, and an open-tab strip with `+`; state in the
  pure `lib/doc-tabs.ts` reducer, mirrored to the URL by `doc-shell`)
  mounted ABOVE the **breadcrumb + action navbar** (`page-header.tsx` /
  `breadcrumb.tsx`, derived from the page's `nest_parent_id` chain; the URL
  stays flat `/p/[pageId]`). Top-level dnd-kit reorder; one block per
  visible element across the **20 block kinds** (`text`, `heading`
  [levels 1–4], `divider`, `data`, `chart`, `diagram`, `callout`, `code`,
  `quote`, `bulleted_list_item`, `numbered_list_item`, `to_do`, `toggle`,
  `table`, `image`, `video`, `audio`, `file`, `bookmark`, `child_page`); `data`
  blocks resolve to live A2UI table/board widgets through
  `@sidanclaw/views-renderer` (the slash menu calls this **Table view**), the
  native `table` block is the Notion **simple table** (real
  `tableHeader`/`tableCell` CRDT nodes in the shared `@sidanclaw/doc-model`
  schema, cells `paragraph+` — not an `embed`), `video`/`audio` are inline URL
  players (`node-views/embed-view.tsx`), and a `child_page` block renders an
  inline link to a nested page. Editing affordances: a **Notion-identical
  24-item slash menu** (`/`, with markdown-shortcut hints + a "Press
  'space' for AI or '/' for commands" empty-line placeholder and a
  **Space→AI inline box** — `inline-ai-prompt.tsx`, a mini composer that
  opens at the caret and generates into the page at that line, not the
  corner dock), floating inline-mark toolbar, person/page
  `@`-mentions, and per-data-block view config (filter / sort / group-by /
  property toggle).
- **Right column** — `DocSidePanel` hosting `FloatingChat`
  (`mode="side-panel"`) docked into the same workspace's doc
  assistant. Hidden below `lg` — the mobile drawer takes over there.

A page chat call creates a server-side draft page; drafts auto-prune in
30 days unless saved. The model authors and edits pages by id via the
Doc v1 page tools (`renderPage` / `patchPage` / `getBlock` /
`queryDataBlock` / `getCurrentPage`) plus the eight user-defined entity
tools — injected by `packages/api/src/doc/inject.ts`. See
[`docs/architecture/features/doc.md`](../../docs/architecture/features/doc.md)
for the page model + tools and
[`docs/plans/doc-v1-execution.md`](../../docs/plans/doc-v1-execution.md)
for the multi-phase rebuild plan.

## Routes

```
app.sidan.ai/                       → server-redirect to /teams when authed, /login otherwise
  /login                               → Google OAuth landing
  /teams                               → workspace picker
  /w/[workspaceId]                     → server-redirect to /w/[workspaceId]/p
  /w/[workspaceId]/p/[pageId]          → the Doc surface (canonical, path-based)
  /w/[workspaceId]/doc?viewId=<id>  → legacy query-param surface; 301-redirects to /p/[pageId]
  /api/auth/callback/google            → OAuth bridge (mirrors apps/web)
  /api/auth/refresh                    → token-refresh bridge (mirrors apps/web)
  /desktop/auth                        → desktop (Electron) sign-in bridge: mints a single-use PKCE code and 302s to sidanclaw://auth?code=… (see docs/architecture/platform/auth.md → "Desktop app sign-in")
  /{brain,studio,workflow,…}           → legacy pre-consolidation bare paths (forwarded path-preserved by the marketing proxy) — `app/[...legacy]/page.tsx` resolves the workspace and redirects to /w/[workspaceId]/<surface>; unknown paths still 404 (`[COMP:app-web/legacy-redirect]`, mapping in `lib/legacy-paths.ts`)
```

Both the `/p/[pageId]` and legacy `/doc` routes gate on a `kind='app'
AND appType='doc'` assistant existing in the workspace. If none does,
they render `<CreateDocAssistant>` first (the setup wizard); after
creation the shell takes over. The `/p/[pageId]` route is the canonical
URL (one stable link per page for deep links, bookmarks, social
unfurls); during the Phase 0 transition it bridges the path `pageId`
into the `?viewId=` query the shell still reads internally.

## Where the chat lives

`src/components/chrome/floating-chat.tsx` — docked bottom-right of the
doc shell. Bound to the workspace's doc assistant; uses
`@sidanclaw/chat-ui` for the composer + message stream. Persists each
exchange to a `channel_type='web'` session with
`app_origin='doc'` (migration 187) so the Recents list in the chat
panel can scope to this surface only.

## Local dev — the realtime sync server is required

Local doc work needs **`apps/doc-sync` running on `:8080`** plus
`DOC_SYNC_URL` / `DOC_SYNC_SECRET` (apps/api → sync, the AI's
`patchPage` write path) and `NEXT_PUBLIC_DOC_SYNC_URL` (browser →
sync, the live editor) set (see `.env.example`). Without the sync server +
these vars the editor can't co-edit and AI-authored page edits
(`renderPage`/`patchPage`) fall back to the frozen `saved_views.page` read
path, so they **won't appear live** on the editor.

## Source layout

```
apps/app-web/src/
├── app/
│   ├── api/auth/{callback/google,refresh}/   # OAuth + refresh bridges
│   ├── login/                                # Google OAuth landing
│   ├── teams/                                # workspace picker
│   ├── w/[workspaceId]/
│   │   ├── layout.tsx                        # workspace context + PERSISTENT chrome: DocSidebarDataProvider + WorkspaceChrome (the hoisted sidebar) wrap EVERY surface
│   │   ├── page.tsx                          # → redirects to /doc
│   │   ├── p/layout.tsx                      # gate + <DocShell> (centre pane + chat only) mount; PERSISTS across [pageId] nav (no flicker)
│   │   ├── p/page.tsx                        # /p index — inert route leaf (returns null; surface is in p/layout.tsx)
│   │   ├── p/[pageId]/page.tsx               # canonical page URL — inert route leaf (returns null)
│   │   └── doc/page.tsx                   # legacy ?viewId= surface (→ /p/[pageId])
│   ├── layout.tsx                            # root: ThemeProvider + I18nProvider
│   └── page.tsx                              # `/` — auth-aware redirect
├── components/
│   ├── doc/                               # block components + shell + editing affordances
│   │   ├── doc-shell.tsx                  # centre page + chat (sidebar hoisted out — see §4 chrome consolidation)
│   │   ├── workspace-chrome.tsx              # PERSISTENT sidebar + inbox flyout + mobile hamburger across ALL /w/[id]/* surfaces
│   │   ├── doc-sidebar-data.tsx           # DocSidebarDataProvider + useSidebarData() — hoisted sidebar lists + page-mutation handlers + ActivePageBridge
│   │   ├── doc-side-panel.tsx             # right chat column (FloatingChat mode="side-panel")
│   │   ├── doc-sidebar.tsx                  # icon toolbar + SURFACE-AWARE body (page tree on Home; panels elsewhere)
│   │   ├── sidebar-panels/                     # Home-only body swaps: brain / studio / workflow surface panels
│   │   ├── doc-sidebar-row.tsx
│   │   ├── sidebar-tree-node.tsx               # recursive Favorites (= Saved) tree node + drag-to-reparent
│   │   ├── breadcrumb.tsx                       # parent-chain breadcrumb (derived; no URL change)
│   │   ├── page-header.tsx
│   │   ├── page-renderer.tsx                 # 18-kind block dispatch + dnd-kit reorder
│   │   ├── block-shell.tsx
│   │   ├── block-{text,heading,divider,data,callout,code,quote}.tsx
│   │   ├── block-{bulleted-list,numbered-list,todo,toggle,image,file,bookmark}.tsx
│   │   ├── block-child-page.tsx                # inline link to a nested page ({ childPageId })
│   │   ├── tiptap-text-block.tsx             # Phase-0 flag (NEXT_PUBLIC_DOC_TIPTAP)
│   │   ├── sortable-block-list.tsx           # DndContext + computeReorder
│   │   ├── drag-handle.tsx                   # Notion-style ⋮⋮ hover handle
│   │   ├── slash-menu.tsx                    # Tiptap slash-command insert
│   │   ├── floating-toolbar.tsx              # inline-mark bubble menu
│   │   ├── mobile-chat-drawer.tsx            # < lg chat drawer
│   │   ├── empty-page-state.tsx, empty-states.tsx, error-states.tsx
│   │   ├── create-doc-assistant.tsx
│   │   ├── mentions/{person-mention,page-mention,mention-popup}.tsx
│   │   └── view-config/{filter-bar,sort-menu,group-by-menu,property-toggle-menu,view-toolbar}.tsx
│   ├── chrome/floating-chat.tsx              # chat dock (side-panel + mobile-drawer modes)
│   ├── route-progress.tsx                    # global nav progress bar (mounted in root layout; the chromeless desktop shell's tab-spinner replacement)
│   ├── workspace-switcher.tsx
│   ├── team-avatar.tsx
│   └── ui/                                   # shadcn / base-ui primitives
│       ├── emoji-picker.tsx                  # emoji-mart page-icon picker (+ PageIconButton trigger)
│       ├── dropdown-menu.tsx                 # base-ui Menu — sidebar row `…` context menu
│       ├── prompt-dialog.tsx                 # themed Promise-returning text-input dialog (Rename; replaces window.prompt)
│       └── …                                 # button, select, confirm-dialog, …
├── lib/
│   ├── api/views.ts                          # SDK over /api/views/* (18-kind Block union incl. child_page/video/audio; reparent) + doc-assistant create
│   ├── api/sessions.ts                       # SDK over /api/sessions/* (FloatingChat resume + recents)
│   ├── api/pending-questions.ts              # askQuestion suspend-resume SDK
│   ├── doc-actions.ts                     # per-block patch/insert helpers + requestUndo
│   ├── sidebar-tree.ts                       # pure: flat view list → nested tree (by nestParentId/position)
│   ├── studio-nav.ts                         # pure: STUDIO_GROUPS — shared by the Studio sidebar panel + the studio layout mobile strip
│   ├── workflow-next-run.ts                  # pure: next-run timestamp from a WorkflowTrigger (Workflow sidebar ranking); never throws
│   ├── schedule-cadence.ts                   # pure: ScheduleSpec → cadence descriptor (page schedule badge); exports DAY_NAME_TO_INDEX
│   ├── route-progress.ts                     # pure: nav-progress store (start/done/subscribe) + isInternalNavigation classifier
│   ├── auth-fetch.ts                         # transparent token refresh
│   ├── i18n/                                 # mirrors apps/web — en/ja/zh
│   ├── theme.tsx                             # light-default tri-state toggle
│   ├── workspace-context.tsx                 # active workspace state
│   └── primary-auth.ts                       # shared sidanclaw OAuth helpers
└── proxy.ts                                  # auth guard (mirrors apps/web)
```

## Theme

Two **orthogonal** dimensions, both owned by `src/lib/theme.tsx` and applied
before paint by `THEME_PREPAINT_SCRIPT` in `<head>` (so no flash):

1. **Mode** — `light` (default) / `dark` / `system`, stored in
   `localStorage["doc:theme"]`, applied as the `.dark` class on `<html>`.
   (Legacy key `feed:theme` is read as a fallback so existing prefs survive.)
   Light-by-default is deliberate: the chat app is dark-by-default; doc is
   the inverse so pages feel like a doc surface.
2. **Palette** — `notion` (**default**, shown as "Default") or `custom` (an
   AI-generated theme), stored in `localStorage["doc:palette"]`,
   applied as `data-palette="<id>"` on `<html>`. Selectable from the bottom-left
   **Theme** dropdown (`doc-sidebar.tsx`'s `PalettePicker`), which offers
   **Default** / **Default Dark** (`THEME_PRESETS` entries = the `notion` palette
   in light vs dark mode), then any workspace custom themes.

**Palette system (`globals.css`).** The bare `:root` / `.dark` = **exact Notion**
(white page, warm-grey `#F7F7F5` sidebar, `#37352F` text, Notion blue `#2383E2`).
**Dark mode softens the brand blue** to Notion's own dark-mode `#529CCA` (with a
deep-navy `--primary-foreground`, `#0A1A24`) — the light-page `#2383E2` misses
WCAG AA on the dark surfaces (white-on-blue ≈ 3.9:1, blue-text ≈ 4.0:1), so don't
copy it into `.dark`. The chat user-bubble is a neutral `--secondary` surface, not
a `--primary` fill, for the same reason.
The `custom` palette's core tokens are injected at runtime under
`[data-palette="custom"]` (+ `.dark[data-palette="custom"]`). Visual **treatments**
(button fill, active-row pill, sidebar wash, text selection) are token-driven
(`--btn-image` / `--btn-glow*` / `--nav-active-*` / `--sidebar-surface-image` /
`--selection-2`): Notion sets them flat/authentic, `custom` sets the
gradient + glow versions. Always use design tokens (`bg-background`, `text-foreground`,
`bg-sidebar`, …) — never raw light/dark or per-palette classes.

3. **Custom themes** — the second palette id, `custom`, is a **workspace-shared,
   AI-generated** theme ("Get my own theme"). Unlike the built-ins, its tokens
   aren't a static `[data-palette]` block — they're generated server-side from a
   prompt (LLM seed → deterministic builder in `packages/shared/src/doc-theme`)
   and injected at runtime as a `<style id="doc-custom-theme">` keyed to
   `[data-palette="custom"]` (whose selector carries the gradient/glow treatments).
   Owned by `lib/theme.tsx` (`applyCustomTheme` + the
   pre-paint inject) + `lib/custom-themes.tsx` (`CustomThemesProvider`, mounted in
   `w/[workspaceId]/layout.tsx`). Capped at 5 per workspace (server-enforced). See
   [`docs/architecture/features/doc-custom-themes.md`](../../docs/architecture/features/doc-custom-themes.md).

## Font

System Chinese-friendly sans stack: PingFang TC → Noto Sans TC →
fallback. Exposed as the `--font-rocknroll` CSS variable in
`globals.css`. **No Google Font is loaded for the body face** — the
earlier RocknRoll_One look was playful but didn't match the main app
surface. Mono stays `JetBrains_Mono` for code blocks only.

**Headings + the page title use a separate `--font-display` stack** that
puts the OS UI font (SF Pro / Segoe UI) *first*, with PingFang kept as the
CJK fallback. This is deliberate, not an oversight: PingFang's heaviest
real master is Semibold (600), so a Latin heading at `font-weight` 700–900
renders as a single mushy faux-bold — every level looked the same weight.
The OS UI font has real masters at each weight, so the headings hit genuine
weights. We match Notion's type treatment: in-body headings are **semibold
(600)**, the page title is **bold (700)**, and tracking is **neutral** (no
negative letter-spacing) — leading with SF Pro is what makes those real
weights land instead of faux-bold. **Don't "unify" headings back onto
`--font-rocknroll`** — that silently re-caps Latin heading weight. CJK
heading glyphs still fall through to PingFang.

## i18n

Locale via the same `locale` cookie as `apps/web`. Server Components
read it via `getServerDictionary()` in `src/lib/i18n/server.ts`; Client
Components via `useT()` from `src/lib/i18n/client.tsx`. Spec:
[`docs/architecture/platform/i18n.md`](../../docs/architecture/platform/i18n.md).

**Hard rule for new strings.** Every user-facing string lands in
`src/lib/i18n/dictionaries/en.ts` first, and is mirrored to `ja.ts` and
`zh.ts` in the same commit. The TypeScript `Dictionary` shape (inferred
from `en.ts`) makes a missing key in another locale a compile error —
that's the gate, lean on it. Transcreate, don't translate; see the i18n
spec for the `zh` register and Apple-Taiwan quality bar.

## Auth

Same JWT + refresh-token flow as `apps/web` — shared sidanclaw OAuth
provider, same cookies (`access_token`, `refresh_token`, `user`). The
proxy (`src/proxy.ts`) redirects unauthenticated traffic to `/login`.
After May 2026, sidanclaw cookies are scoped to `.sidan.ai` so the
session carries across `sidan.ai` ↔ `app.sidan.ai` ↔ `feed.sidan.ai`
without re-auth.

## Component map

Per-component test rows live in
[`docs/workflow/component-map.md`](../../docs/workflow/component-map.md)
under the `app-web/*` tags. Add a row in the same commit as any new
component — that's the project-wide convention.

## Common gotchas

- **app-web does not host an assistant detail or settings page.**
  Anything that touches assistant config (system prompt, capabilities,
  connectors, sharing, billing) must deep-link back to
  `${APP_URL}/...` — never reimplement it here.
- **Do not snapshot data blocks.** Every page open re-resolves `data`
  blocks through `GET /api/views/:id/payload`. Caching the rendered
  shape would invalidate on every primitive write — see the freshness
  rule in `docs/architecture/features/views.md`.
- **Sessions started here carry `app_origin='doc'`.** Don't strip
  that on append; the chat-panel Recents filter relies on it.
- **The `/api/views/*` SDK is duplicated, not imported from `apps/web`.**
  `apps/web/src/lib/api/views.ts` and `apps/app-web/src/lib/api/views.ts`
  intentionally diverge — keep the wire types in sync with
  `packages/core/src/views/blocks.ts` and `types.ts`.
