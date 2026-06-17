/**
 * findGDriveFiles — search the assistant's own index of Google Drive files
 * it has created for the user. This does *not* hit Google Drive directly;
 * the `drive.file` scope cannot list or search Drive at large. Instead, we
 * keep a local `gdrive_files` table populated by the sheets/docs/slides
 * create callbacks.
 *
 * Reconcile policy: list reads trust the DB (lazy reconcile), while any
 * downstream read/write callback refreshes the stored title via
 * `updateOnAccess`. See docs/architecture/integrations/mcp.md → "The
 * `gdrive` connector".
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../types.js'

export type GDriveFileKind = 'sheet' | 'doc' | 'slide'

export type GDriveFile = {
  id: string
  userId: string
  kind: GDriveFileKind
  externalId: string
  title: string
  url: string
  createdAt: Date
  lastSeenAt: Date
}

export type GDriveFilesStore = {
  /**
   * Record a newly created Drive file. Idempotent on (userId, externalId)
   * so the same row isn't duplicated if a create callback runs twice.
   */
  insert(params: {
    userId: string
    kind: GDriveFileKind
    externalId: string
    title: string
    url: string
  }): Promise<GDriveFile>

  /**
   * List a user's indexed files, newest first. `kind: 'all'` (or omitted)
   * returns every kind. `query` is a case-insensitive substring match on
   * the title.
   */
  list(
    userId: string,
    params: { kind?: GDriveFileKind | 'all'; query?: string; limit?: number },
  ): Promise<GDriveFile[]>

  /**
   * Bump last_seen_at (and sync the title if it drifted) when a downstream
   * read/write tool successfully opens the file.
   */
  updateOnAccess(userId: string, externalId: string, title: string): Promise<void>
}

const KIND_VALUES = ['all', 'sheet', 'doc', 'slide'] as const
const KIND_FILTER_VALUES = ['sheet', 'doc', 'slide'] as const

export function createGDriveFilesTools(
  store: Pick<GDriveFilesStore, 'list'>,
  userId: string,
): Tool[] {
  const findFiles = buildTool({
    name: 'findGDriveFiles',
    description:
      'Search the spreadsheets, documents, and presentations this assistant has previously created for the user in Google Drive. ' +
      'Results come from a local index — the drive.file scope cannot list arbitrary Drive files, so this only covers files the assistant made. ' +
      'Pass `kind` to filter by type, or `query` to substring-match the title. Returns kind, title, url, and createdAt.',
    inputSchema: z.object({
      kind: z.enum(KIND_VALUES).optional().describe(
        '`all` or omit to search every kind. Otherwise restrict to one of sheet | doc | slide.',
      ),
      query: z.string().optional().describe('Case-insensitive substring match on the file title.'),
      limit: z.number().int().positive().max(200).optional().describe('Max results to return (default 50).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 5_000,

    async execute(input) {
      try {
        const rows = await store.list(userId, {
          kind: input.kind,
          query: input.query,
          limit: input.limit,
        })
        const data = rows.map((r) => ({
          kind: r.kind,
          title: r.title,
          url: r.url,
          externalId: r.externalId,
          createdAt: r.createdAt.toISOString(),
        }))
        return { data: { count: data.length, files: data } }
      } catch (err) {
        return {
          data: `findGDriveFiles error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })

  return [findFiles]
}

/** Exported for callers that need to validate a kind coming from external input. */
export const GDRIVE_FILE_KINDS = KIND_FILTER_VALUES
