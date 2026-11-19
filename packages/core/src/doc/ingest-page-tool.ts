/**
 * `ingestPage` chat tool — the assistant-on-request half of doc-page → brain
 * distillation (canvas-brain-distillation.md §0, the `ingestPage(pageId)` tool).
 * "Add this page to the brain": the model calls it, the page's authored layer is
 * distilled into facts + a retrievable source via Pipeline B.
 *
 * Like the manual route, it ENQUEUES (the runner runs in the background — see
 * the API wiring) and returns immediately: "canvas is just another source_kind;
 * never runs Pipeline B inline." The actual distillation + DB/embedding work
 * lives in the API runner (`packages/api/src/doc/ingest-page-runner.ts`); this
 * tool only invokes the injected `ingestPage` port, keeping core DB-free.
 *
 * The tool description names no other tool / connector (tool-awareness rule).
 *
 * [COMP:doc/ingest-page-tool]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '@use-brian/agent-runtime/tools/types.js'

const ingestPageInputSchema = z.object({
  pageId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The page to ingest. Omit to ingest the page currently in focus (the page you are editing).',
    ),
})

export type IngestPageToolDeps = {
  /**
   * Enqueue the doc-page distillation runner (RLS-scoped to the caller). Runs in
   * the background; resolves once enqueued. Throws on an access / not-found
   * failure so the tool can surface it.
   */
  ingestPage: (args: { userId: string; pageId: string }) => Promise<void>
  /** The page the user is looking at — the default target when `pageId` is omitted. */
  anchorPageId?: string | null
}

export function createIngestPageTool(deps: IngestPageToolDeps): Tool {
  return buildTool({
    requiresCapability: 'page',
    name: 'ingestPage',
    description:
      'Add a saved doc page to the brain: distil its authored prose, decisions, and ' +
      'commitments into searchable facts plus a retrievable page source, so future ' +
      'questions across pages can find it. Call when the user asks to "add this page to ' +
      'the brain" / "remember this page" / "sync this page". Ingestion runs in the ' +
      'background; it returns immediately. Re-ingesting an unchanged page is a safe no-op.',
    inputSchema: ingestPageInputSchema,
    isConcurrencySafe: false,
    isReadOnly: false,
    timeoutMs: 15_000,

    async execute(input, context) {
      const pageId = input.pageId ?? deps.anchorPageId ?? null
      if (!pageId) {
        return {
          data: 'No page to ingest. Pass a pageId, or open the page first.',
          isError: true,
        }
      }
      try {
        await deps.ingestPage({ userId: context.userId, pageId })
        return {
          data: {
            kind: 'page_ingest_queued' as const,
            pageId,
            note: 'Queued for brain ingestion. The page will be searchable once processing completes.',
          },
        }
      } catch (err) {
        return {
          data: `Could not ingest page ${pageId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          isError: true,
        }
      }
    },
  })
}
