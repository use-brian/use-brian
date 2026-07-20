/**
 * Deck store — the open impl of core's `DeckStorePort` over `workspace_decks`
 * (migration 323), plus the list/read surface the /api/decks routes use.
 * Emits the `deck` workspace event (SSE spine) on create/update so the
 * app-web live preview refreshes without polling.
 *
 * Scoping discipline: workspace_id always comes from the caller-derived
 * context (FilesContext / route membership check), never from tool input.
 *
 * Spec: docs/architecture/features/deck-generation.md. [COMP:api/deck-store]
 */
import type { DeckRecord, DeckStorePort, FilesContext } from '@use-brian/core'
import type { DeckSpec, DeckStyle } from '@use-brian/shared/decks'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'
import { query } from './client.js'

type Row = {
  id: string
  workspace_id: string
  title: string
  spec: DeckSpec
  style: DeckStyle | null
  style_source: string | null
  file_path: string
  version: number
  created_by: string | null
  created_at: Date
  updated_at: Date
}

export type DeckListItem = {
  id: string
  workspaceId: string
  title: string
  slideCount: number
  filePath: string
  styleSource: string | null
  version: number
  updatedAt: string
}

function toRecord(row: Row): DeckRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    spec: row.spec,
    style: row.style,
    styleSource: row.style_source,
    filePath: row.file_path,
    version: row.version,
  }
}

export type DeckStore = DeckStorePort & {
  /** Route surface — newest first. */
  listSystem(workspaceId: string, limit?: number): Promise<DeckListItem[]>
  /** Route surface — single deck, workspace-checked by the route. */
  getSystem(deckId: string): Promise<(DeckRecord & { updatedAt: string }) | null>
}

export function createDeckStore(): DeckStore {
  return {
    async create(ctx: FilesContext, row) {
      const res = await query<Row>(
        `INSERT INTO workspace_decks
           (id, workspace_id, title, spec, style, style_source, file_path, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          row.id,
          ctx.workspaceId,
          row.title,
          JSON.stringify(row.spec),
          row.style ? JSON.stringify(row.style) : null,
          row.styleSource,
          row.filePath,
          ctx.userId,
        ],
      )
      notifyWorkspaceChange(ctx.workspaceId, 'deck', 'create', row.id)
      return toRecord(res.rows[0])
    },

    async get(ctx: FilesContext, deckId: string) {
      const res = await query<Row>(
        `SELECT * FROM workspace_decks WHERE id = $1 AND workspace_id = $2`,
        [deckId, ctx.workspaceId],
      )
      return res.rows[0] ? toRecord(res.rows[0]) : null
    },

    async update(ctx: FilesContext, deckId: string, patch) {
      const res = await query<Row>(
        `UPDATE workspace_decks
            SET title = $3, spec = $4, style = $5, style_source = $6, version = version + 1
          WHERE id = $1 AND workspace_id = $2 AND version = $7
          RETURNING *`,
        [
          deckId,
          ctx.workspaceId,
          patch.title,
          JSON.stringify(patch.spec),
          patch.style ? JSON.stringify(patch.style) : null,
          patch.styleSource,
          patch.expectedVersion,
        ],
      )
      if (res.rows[0]) {
        notifyWorkspaceChange(ctx.workspaceId, 'deck', 'update', deckId)
        return toRecord(res.rows[0])
      }
      const exists = await query<{ id: string }>(
        `SELECT id FROM workspace_decks WHERE id = $1 AND workspace_id = $2`,
        [deckId, ctx.workspaceId],
      )
      return exists.rows[0] ? 'version_conflict' : null
    },

    async listSystem(workspaceId, limit = 50) {
      const res = await query<Row>(
        `SELECT * FROM workspace_decks WHERE workspace_id = $1 ORDER BY updated_at DESC LIMIT $2`,
        [workspaceId, limit],
      )
      return res.rows.map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        title: row.title,
        slideCount: (row.spec.slides?.length ?? 0) + 1,
        filePath: row.file_path,
        styleSource: row.style_source,
        version: row.version,
        updatedAt: row.updated_at.toISOString(),
      }))
    },

    async getSystem(deckId) {
      const res = await query<Row>(`SELECT * FROM workspace_decks WHERE id = $1`, [deckId])
      const row = res.rows[0]
      return row ? { ...toRecord(row), updatedAt: row.updated_at.toISOString() } : null
    },
  }
}
