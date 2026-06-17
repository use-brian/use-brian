/**
 * `findPage` — discover and read a doc page by TITLE.
 *
 * Every other doc tool (`getCurrentPage` / `getSection` / `exportPage` /
 * `patchPage`) addresses a page it ALREADY has — by `pageId` — and they are
 * injected only on the doc surface or a page-anchored workflow step. So an
 * agent reasoning "read the 'Worker Maintenance Log' doc page" in a plain chat,
 * or in an un-anchored scheduled / workflow `assistant_call` turn, has no way to
 * turn a title into a page: no list-by-title verb, and frequently no doc tools
 * at all. It flails through unrelated knowledge tools, and on a delivery path it
 * can narrate that flailing straight to the user (prod incident 2026-06-15:
 * a cron "blockers" monitor shipped its tool-hunting monologue to Telegram).
 *
 * `findPage` is the missing discovery verb. It is read-only and registered
 * ALWAYS-ON (not behind the doc-surface gate), so it is native everywhere:
 * interactive chat, channels, and un-anchored workflow / cron steps. One tool,
 * two modes:
 *
 *   - search   `{ title }`                  → ranked matches `[{ pageId, title, … }]`
 *   - read     `{ pageId }`                 → that page's full Markdown
 *   - one-shot `{ title, includeContent }`  → matches + content when exactly one hit
 *
 * The one-shot read is what makes the tool self-sufficient in contexts that
 * lack `exportPage`: the agent goes from a title straight to the page body in a
 * single call.
 *
 * RLS does the access control. Both store reads run user-scoped
 * (`queryWithRLS`), so workspace membership + per-page clearance already confine
 * what a title search can surface — there is no bespoke clearance logic here.
 *
 * Spec: docs/architecture/features/doc.md → "Finding a page by title".
 *
 * [COMP:doc/find-page]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import type { SavedViewListRow, SavedViewStore } from '../views/types.js'
import type { DocPageStore } from './tools.js'
import { pageToMarkdown } from './to-markdown.js'

/** Narrow dep bag — `findPage` only needs to list pages and read one. */
export type FindPageToolDeps = {
  savedViewStore: Pick<SavedViewStore, 'list'>
  docPageStore: Pick<DocPageStore, 'getVersionedPage'>
}

/** Cap on returned matches — enough to disambiguate, not enough to flood. */
export const FIND_PAGE_MAX_MATCHES = 10
/** Cap on returned page Markdown so a huge page can't blow the turn context. */
export const FIND_PAGE_MARKDOWN_CAP = 8_000

/** Lowercase alphanumeric tokens — shared with the title-overlap fallback. */
function titleTokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

/**
 * Rank pages by how well their title matches `query`, strongest first, and
 * drop the non-matches. Pure (no I/O) so the matcher is unit-testable.
 *
 * Tiers (case-insensitive): exact title → prefix → substring → token overlap.
 * A page that shares no token with the query scores 0 and is excluded. Ties
 * break toward the more recently updated page (the live log, not a stale copy).
 */
export function rankPagesByTitle(
  rows: SavedViewListRow[],
  query: string,
  limit = FIND_PAGE_MAX_MATCHES,
): SavedViewListRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const qTokens = new Set(titleTokens(q))

  const scored = rows.map((row) => {
    const name = row.name.toLowerCase()
    let score: number
    if (name === q) score = 1000
    else if (name.startsWith(q)) score = 500
    else if (name.includes(q)) score = 250
    else {
      const nameTokens = new Set(titleTokens(name))
      let overlap = 0
      for (const t of qTokens) if (nameTokens.has(t)) overlap++
      score = overlap * 25
    }
    return { row, score }
  })

  return scored
    .filter((s) => s.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || b.row.updatedAt.getTime() - a.row.updatedAt.getTime(),
    )
    .slice(0, limit)
    .map((s) => s.row)
}

function capMarkdown(md: string): { markdown: string; truncated: boolean } {
  if (md.length <= FIND_PAGE_MARKDOWN_CAP) return { markdown: md, truncated: false }
  return {
    markdown: `${md.slice(0, FIND_PAGE_MARKDOWN_CAP)}\n\n…[truncated — call findPage again with this pageId, or getSection for one section]`,
    truncated: true,
  }
}

const findPageInputSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe(
      'Title (or partial title) of the doc page to find. Case-insensitive; results are ranked by closeness. Omit when reading a specific page by `pageId`.',
    ),
  pageId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Read one specific page by id (e.g. a `pageId` returned by a prior findPage match). Returns that page as Markdown.',
    ),
  includeContent: z
    .boolean()
    .optional()
    .describe(
      'When searching by `title` and exactly one page matches, also return its full Markdown — so you read it in one call without a follow-up. Ignored when several pages match (pick one and re-call with its `pageId`). A `pageId` read always returns content.',
    ),
})

/**
 * Build the always-on `findPage` tool. Wired into `allTools` at API boot
 * (`apps/api/src/index.ts`) rather than through `injectDocTools`, so it is
 * available on every surface, including un-anchored workflow / cron turns.
 */
export function createFindPageTool(deps: FindPageToolDeps): Tool {
  return buildTool({
    name: 'findPage',
    description:
      'Find a doc page by its title (or read one by id). Use this whenever you need a doc page you do not already have open — for example a scheduled or workflow task that says "read the X doc page". ' +
      '\n\n' +
      'Search: pass `title` to get ranked matches, each `{ pageId, title, icon, state, updatedAt }`. Read: pass `pageId` to get that page as Markdown. One-shot: pass `title` with `includeContent:true` to get the body directly when exactly one page matches. ' +
      '\n\n' +
      'If no page matches, `matches` is empty — the page does not exist (or you cannot access it); do not keep searching other tools for it. If several match, pick the right `pageId` and re-call to read it.',
    inputSchema: findPageInputSchema,
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input, context) {
      if (!context.workspaceId) {
        return { data: 'No workspace in context — cannot search pages.', isError: true }
      }
      if (!input.title && !input.pageId) {
        return {
          data: 'Pass `title` to search for a page, or `pageId` to read a specific one.',
          isError: true,
        }
      }

      // Read-by-id: the agent already has a pageId (its own or a prior match).
      if (input.pageId) {
        const current = await deps.docPageStore.getVersionedPage(context.userId, input.pageId)
        if (!current) {
          return {
            data: `Page not found: ${input.pageId}. It may have been deleted or you may not have access.`,
            isError: true,
          }
        }
        return {
          data: {
            kind: 'doc_find_page',
            match: { pageId: input.pageId, title: current.title },
            content: capMarkdown(pageToMarkdown(current.page, current.title)),
          },
        }
      }

      // Search-by-title: list (RLS-scoped, all states) then rank.
      const rows = await deps.savedViewStore.list({
        userId: context.userId,
        workspaceId: context.workspaceId,
        state: 'all',
      })
      const matches = rankPagesByTitle(rows, input.title as string)
      const result: {
        kind: 'doc_find_page'
        query: string
        matches: {
          pageId: string
          title: string
          icon: string | null
          state: string
          updatedAt: string
        }[]
        content?: { markdown: string; truncated: boolean }
      } = {
        kind: 'doc_find_page',
        query: input.title as string,
        matches: matches.map((m) => ({
          pageId: m.id,
          title: m.name,
          icon: m.icon,
          state: m.state,
          updatedAt: m.updatedAt.toISOString(),
        })),
      }

      // One-shot read: unambiguous single hit → fetch its body so the agent
      // doesn't need a second round-trip (critical where `exportPage` is absent).
      if (input.includeContent && matches.length === 1) {
        const current = await deps.docPageStore.getVersionedPage(context.userId, matches[0].id)
        if (current) result.content = capMarkdown(pageToMarkdown(current.page, current.title))
      }

      return { data: result }
    },
  })
}
