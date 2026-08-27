/**
 * Standalone/open UsageStore implementation.
 *
 * The goal driver treats metering as a hard pre-iteration barrier. Hosted
 * satisfies it with the closed billing ledger; standalone satisfies it here
 * with a local COGS-only ledger. This store intentionally performs no credit,
 * plan, surcharge, or daily-billing writes.
 *
 * [COMP:goals/oss-metering]
 */
import type { UsageStore } from '@use-brian/core'
import { tierForModel } from '../model-resolution.js'
import { query } from './client.js'

const EXCLUDE_OVERHEAD = `source NOT LIKE 'overhead:%'`

function totalOf(rows: Array<{ total: string }> | undefined): number {
  return Number.parseFloat(rows?.[0]?.total ?? '0')
}

export function createOssUsageStore(): UsageStore {
  return {
    async recordUsage(params) {
      const modelTier = params.modelTier ?? tierForModel(params.model)
      const tail = [
        params.sessionId,
        params.model,
        modelTier,
        params.inputTokens,
        params.outputTokens,
        params.cacheReadTokens ?? 0,
        params.cacheWriteTokens ?? 0,
        params.actualCostUsd,
        params.source,
        params.userMessageId ?? null,
        params.triggerKey ?? null,
        params.providerKeySource ?? null,
        params.audioSeconds ?? null,
        params.sourceEpisodeId ?? null,
      ]

      let inserted: { rows: Array<{ workspace_id: string; user_id: string }> }
      if (params.assistantId) {
        inserted = await query<{ workspace_id: string; user_id: string }>(
          `INSERT INTO oss_usage_tracking
             (user_id, workspace_id, actor_user_id, assistant_id, session_id,
              model, model_tier, input_tokens, output_tokens, cache_read_tokens,
              cache_write_tokens, actual_cost_usd, source, user_message_id,
              trigger_key, provider_key_source, audio_seconds, source_episode_id)
           SELECT COALESCE(NULLIF($1, '')::uuid, a.owner_user_id, w.owner_user_id),
                  a.workspace_id,
                  COALESCE(NULLIF($2, '')::uuid, NULLIF($1, '')::uuid,
                           a.owner_user_id, w.owner_user_id),
                  a.id, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                  $15, $16, $17
             FROM assistants a
             JOIN workspaces w ON w.id = a.workspace_id
            WHERE a.id = $3::uuid
           RETURNING workspace_id, user_id`,
          [params.userId, params.actorUserId ?? params.userId, params.assistantId, ...tail],
        )
      } else if (params.workspaceId) {
        inserted = await query<{ workspace_id: string; user_id: string }>(
          `INSERT INTO oss_usage_tracking
             (user_id, workspace_id, actor_user_id, assistant_id, session_id,
              model, model_tier, input_tokens, output_tokens, cache_read_tokens,
              cache_write_tokens, actual_cost_usd, source, user_message_id,
              trigger_key, provider_key_source, audio_seconds, source_episode_id)
           SELECT COALESCE(NULLIF($1, '')::uuid, a.owner_user_id, w.owner_user_id),
                  a.workspace_id,
                  COALESCE(NULLIF($2, '')::uuid, NULLIF($1, '')::uuid,
                           a.owner_user_id, w.owner_user_id),
                  a.id, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                  $15, $16, $17
             FROM (SELECT id, owner_user_id, workspace_id
                     FROM assistants
                    WHERE workspace_id = $3::uuid
                    ORDER BY created_at ASC
                    LIMIT 1) a
             JOIN workspaces w ON w.id = a.workspace_id
           RETURNING workspace_id, user_id`,
          [params.userId, params.actorUserId ?? params.userId, params.workspaceId, ...tail],
        )
      } else {
        console.warn(
          `[oss-usage-store] recordUsage: no assistantId and no workspaceId (source ${params.source}) - usage not recorded`,
        )
        return
      }

      if (!inserted.rows[0]) {
        console.warn(
          `[oss-usage-store] recordUsage: assistant ${params.assistantId || `(workspace ${params.workspaceId})`} not found - usage not recorded`,
        )
      }
    },

    async getWeeklyCost(workspaceId) {
      const result = await query<{ total: string }>(
        `SELECT COALESCE(SUM(actual_cost_usd), 0) AS total
           FROM oss_usage_tracking
          WHERE workspace_id = $1
            AND created_at >= now() - interval '7 days'
            AND ${EXCLUDE_OVERHEAD}`,
        [workspaceId],
      )
      return totalOf(result.rows)
    },

    async getEarliestChargeAfter(workspaceId, after) {
      const result = await query<{ created_at: Date }>(
        `SELECT created_at
           FROM oss_usage_tracking
          WHERE workspace_id = $1
            AND created_at >= $2
            AND ${EXCLUDE_OVERHEAD}
          ORDER BY created_at ASC
          LIMIT 1`,
        [workspaceId, after],
      )
      return result.rows[0]?.created_at ?? null
    },

    async getSessionCostUsd(sessionId) {
      const result = await query<{ total: string }>(
        `SELECT COALESCE(SUM(actual_cost_usd), 0) AS total
           FROM oss_usage_tracking
          WHERE session_id = $1
            AND ${EXCLUDE_OVERHEAD}`,
        [sessionId],
      )
      return totalOf(result.rows)
    },

    async getAssistantWeeklyCost(workspaceId, assistantId) {
      const result = await query<{ total: string }>(
        `SELECT COALESCE(SUM(actual_cost_usd), 0) AS total
           FROM oss_usage_tracking
          WHERE workspace_id = $1
            AND assistant_id = $2
            AND created_at >= now() - interval '7 days'
            AND ${EXCLUDE_OVERHEAD}`,
        [workspaceId, assistantId],
      )
      return totalOf(result.rows)
    },

    async getAssistantModelMix(workspaceId, assistantId) {
      const result = await query<{ model: string; costUsd: string }>(
        `SELECT model, COALESCE(SUM(actual_cost_usd), 0) AS "costUsd"
           FROM oss_usage_tracking
          WHERE workspace_id = $1
            AND assistant_id = $2
            AND created_at >= now() - interval '7 days'
            AND ${EXCLUDE_OVERHEAD}
          GROUP BY model
          ORDER BY "costUsd" DESC`,
        [workspaceId, assistantId],
      )
      return result.rows.map((row) => ({
        model: row.model,
        costUsd: Number.parseFloat(row.costUsd),
      }))
    },

    async getAssistantDailyTrend(workspaceId, assistantId, days) {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      const result = await query<{ date: string; costUsd: string }>(
        `SELECT DATE(created_at)::text AS date,
                COALESCE(SUM(actual_cost_usd), 0) AS "costUsd"
           FROM oss_usage_tracking
          WHERE workspace_id = $1
            AND assistant_id = $2
            AND created_at >= $3
            AND ${EXCLUDE_OVERHEAD}
          GROUP BY DATE(created_at)
          ORDER BY date ASC`,
        [workspaceId, assistantId, cutoff],
      )
      return result.rows.map((row) => ({
        date: row.date,
        costUsd: Number.parseFloat(row.costUsd),
      }))
    },
  }
}
