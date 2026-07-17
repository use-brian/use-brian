/**
 * Home dock store — the per-workspace `HomeDockLayout` artifact
 * (`home_dock_layouts`, migration 266). One row per workspace.
 *
 * `get` validates the stored JSONB against the core schema and returns null on
 * mismatch, so a malformed/legacy artifact degrades to the deterministic
 * fallback rather than throwing. `put` upserts on the `workspace_id` primary
 * key. Both run under the caller's RLS context (`queryWithRLS`).
 *
 * Implements `HomeDockStore` from `@use-brian/core`. See
 * docs/architecture/features/home-dock.md.
 *
 * [COMP:api/home-dock-store]
 */

import { homeDockLayoutSchema, type HomeDockStore } from '@use-brian/core'
import { queryWithRLS } from './client.js'

export function createDbHomeDockStore(): HomeDockStore {
  return {
    async get(userId, workspaceId) {
      const res = await queryWithRLS<{ layout: unknown }>(
        userId,
        `SELECT layout FROM home_dock_layouts WHERE workspace_id = $1`,
        [workspaceId],
      )
      const raw = res.rows[0]?.layout
      if (raw == null) return null
      const parsed = homeDockLayoutSchema.safeParse(raw)
      return parsed.success ? parsed.data : null
    },

    async put(userId, workspaceId, layout) {
      await queryWithRLS(
        userId,
        `INSERT INTO home_dock_layouts
           (workspace_id, layout, generated_by_assistant_id, generated_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (workspace_id) DO UPDATE
           SET layout = EXCLUDED.layout,
               generated_by_assistant_id = EXCLUDED.generated_by_assistant_id,
               generated_at = EXCLUDED.generated_at,
               updated_at = NOW()`,
        [
          workspaceId,
          JSON.stringify(layout),
          layout.generatedByAssistantId,
          layout.generatedAt,
        ],
      )
    },
  }
}
