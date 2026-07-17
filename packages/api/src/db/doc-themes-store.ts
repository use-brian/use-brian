/**
 * Doc custom-themes store, backed by PostgreSQL (migration 226).
 *
 * Workspace-shared, AI-generated colour themes. The store owns the **invisible
 * hard cap of 5 per workspace** via an atomic conditional INSERT — a
 * count-then-insert race can't slip a 6th past because the count is evaluated
 * inside the same statement that inserts.
 *
 * RLS via the `doc_themes_workspace_member` policy — every workspace member
 * can read / create / rename / delete themes in their workspaces. All reads +
 * writes go through `queryWithRLS`.
 *
 * `seed` / `tokens` are JSONB; node-postgres parses them back to objects, so
 * `row.seed` is a {@link ThemeSeed} and `row.tokens` a {@link CustomThemePayload}.
 *
 * [COMP:doc-themes/store]
 */

import {
  MAX_CUSTOM_THEMES_PER_WORKSPACE,
  type CustomThemePayload,
  type ThemeSeed,
} from '@use-brian/shared'
import { queryWithRLS } from './client.js'

/** Thrown by `create` when the workspace already holds the max custom themes. */
export class ThemeLimitReachedError extends Error {
  constructor() {
    super('Workspace has reached the maximum number of custom themes')
    this.name = 'ThemeLimitReachedError'
  }
}

export type StoredDocTheme = {
  id: string
  workspaceId: string
  createdBy: string
  name: string
  description: string | null
  prompt: string
  seed: ThemeSeed
  tokens: CustomThemePayload
  createdAt: Date
  updatedAt: Date
}

export type CreateDocThemeInput = {
  userId: string
  workspaceId: string
  name: string
  description: string | null
  prompt: string
  seed: ThemeSeed
  tokens: CustomThemePayload
}

export type DocThemeStore = {
  list(userId: string, workspaceId: string): Promise<StoredDocTheme[]>
  getById(userId: string, id: string): Promise<StoredDocTheme | null>
  /** Atomic + cap-checked. Throws {@link ThemeLimitReachedError} at the cap. */
  create(input: CreateDocThemeInput): Promise<StoredDocTheme>
  rename(userId: string, id: string, name: string): Promise<StoredDocTheme | null>
  /** Replace the generated content (seed + tokens + description) — the refine path.
   *  Does NOT touch `name` (the user owns that) or the cap (it's an update). */
  updateGenerated(
    userId: string,
    id: string,
    fields: { seed: ThemeSeed; tokens: CustomThemePayload; description: string | null },
  ): Promise<StoredDocTheme | null>
  remove(userId: string, id: string): Promise<boolean>
}

const SELECT = `
  id,
  workspace_id AS "workspaceId",
  created_by   AS "createdBy",
  name,
  description,
  prompt,
  seed,
  tokens,
  created_at   AS "createdAt",
  updated_at   AS "updatedAt"
`

type Row = StoredDocTheme

export function createDbDocThemesStore(): DocThemeStore {
  return {
    async list(userId, workspaceId) {
      const result = await queryWithRLS<Row>(
        userId,
        `SELECT ${SELECT} FROM doc_themes
          WHERE workspace_id = $1
          ORDER BY created_at ASC`,
        [workspaceId],
      )
      return result.rows
    },

    async getById(userId, id) {
      const result = await queryWithRLS<Row>(
        userId,
        `SELECT ${SELECT} FROM doc_themes WHERE id = $1`,
        [id],
      )
      return result.rows[0] ?? null
    },

    async create({ userId, workspaceId, name, description, prompt, seed, tokens }) {
      // Atomic cap: the INSERT only fires when the workspace is below the limit.
      // Evaluating COUNT(*) inside the same statement closes the
      // count-then-insert race two concurrent creators could otherwise exploit.
      const result = await queryWithRLS<Row>(
        userId,
        `INSERT INTO doc_themes
           (workspace_id, created_by, name, description, prompt, seed, tokens)
         SELECT $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb
          WHERE (SELECT COUNT(*) FROM doc_themes WHERE workspace_id = $1) < $8
         RETURNING ${SELECT}`,
        [
          workspaceId,
          userId,
          name,
          description,
          prompt,
          JSON.stringify(seed),
          JSON.stringify(tokens),
          MAX_CUSTOM_THEMES_PER_WORKSPACE,
        ],
      )
      const row = result.rows[0]
      if (!row) throw new ThemeLimitReachedError()
      return row
    },

    async rename(userId, id, name) {
      const result = await queryWithRLS<Row>(
        userId,
        `UPDATE doc_themes SET name = $2, updated_at = now()
          WHERE id = $1
        RETURNING ${SELECT}`,
        [id, name],
      )
      return result.rows[0] ?? null
    },

    async updateGenerated(userId, id, { seed, tokens, description }) {
      const result = await queryWithRLS<Row>(
        userId,
        `UPDATE doc_themes
            SET seed = $2::jsonb, tokens = $3::jsonb, description = $4, updated_at = now()
          WHERE id = $1
        RETURNING ${SELECT}`,
        [id, JSON.stringify(seed), JSON.stringify(tokens), description],
      )
      return result.rows[0] ?? null
    },

    async remove(userId, id) {
      const result = await queryWithRLS<{ id: string }>(
        userId,
        `DELETE FROM doc_themes WHERE id = $1 RETURNING id`,
        [id],
      )
      return result.rows.length > 0
    },
  }
}
