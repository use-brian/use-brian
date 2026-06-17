import type {
  MemoryForPromotion,
  EntitySnapshotForPromotion,
  MemoryToEntityPromotionPorts,
} from '@sidanclaw/core'
import type { Sensitivity } from '@sidanclaw/core'
import { query } from './client.js'
import { supersedeEntity as dbSupersedeEntity } from './entities-store.js'

/**
 * DB adapter for `MemoryToEntityPromotionPorts` — the three ports
 * `promoteMemoryToEntity` (WU-6.10) requires. Backs the chat-side
 * `acceptBrainCandidate` tool (Q8 delegation).
 *
 * The two read ports use system-bypass `query` because the chat tool
 * has already established the actor's RLS via its own context — these
 * helpers only need the raw rows for the orchestrator's own gates
 * (author check, workspace match, supersession state). The write
 * adapter delegates to the existing `entities-store.ts:supersedeEntity`
 * which carries actor + RLS internally.
 */
export function createMemoryToEntityPromotionStore(): MemoryToEntityPromotionPorts {
  return {
    async getMemoryForPromotion(memoryId: string): Promise<MemoryForPromotion | null> {
      const result = await query<{
        id: string
        userId: string | null
        assistantId: string | null
        summary: string
        detail: string | null
        sensitivity: Sensitivity
        createdByUserId: string
        validTo: Date | null
        retractedAt: Date | null
        workspaceId: string
      }>(
        `SELECT id,
                user_id              AS "userId",
                assistant_id         AS "assistantId",
                summary,
                detail,
                sensitivity,
                created_by_user_id   AS "createdByUserId",
                valid_to             AS "validTo",
                retracted_at         AS "retractedAt",
                workspace_id         AS "workspaceId"
           FROM memories
          WHERE id = $1`,
        [memoryId],
      )
      if (result.rows.length === 0) return null
      return result.rows[0]
    },

    async getEntityForPromotion(entityId: string): Promise<EntitySnapshotForPromotion | null> {
      const result = await query<{
        id: string
        workspaceId: string
        attributes: Record<string, unknown>
        validTo: Date | null
        retractedAt: Date | null
      }>(
        `SELECT id,
                workspace_id  AS "workspaceId",
                attributes,
                valid_to      AS "validTo",
                retracted_at  AS "retractedAt"
           FROM entities
          WHERE id = $1`,
        [entityId],
      )
      if (result.rows.length === 0) return null
      return result.rows[0]
    },

    async supersedeEntity({ oldEntityId, mergedAttributes, promotedByUserId }) {
      // Delegates to the existing D.7 supersession primitive. The patch
      // only carries `attributes`; sourceEpisodeId / source / displayName
      // / canonicalId / sensitivity all default to the old row's values
      // per `EntitySupersedePatch`. Source memory id is captured in the
      // `brain_candidates` audit row, not the entity supersession chain.
      const newRow = await dbSupersedeEntity(promotedByUserId, oldEntityId, {
        attributes: mergedAttributes,
      })
      if (!newRow) {
        throw new Error(
          `supersedeEntity returned null — old entity ${oldEntityId} not currently live`,
        )
      }
      return { newEntityId: newRow.id }
    },
  }
}
