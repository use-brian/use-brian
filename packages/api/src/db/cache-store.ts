import type { CacheStore } from '@use-brian/core'
import { query } from './client.js'

export function createDbCacheStore(): CacheStore {
  return {
    async get(sessionId, toolName, actorUserId = null) {
      // Scope by the acting user: on workspace-shared / doc-thread sessions
      // multiple users drive one session_id, so an actor-less read would serve
      // one member's cached fetch to another (cross-tenant — audit #7).
      // `IS NOT DISTINCT FROM` so a null asker only matches null-actor rows.
      const result = await query<{ result: unknown }>(
        `SELECT result FROM tool_result_cache
         WHERE session_id = $1 AND tool_name = $2
           AND actor_user_id IS NOT DISTINCT FROM $3
           AND expires_at > now()
         ORDER BY created_at DESC LIMIT 1`,
        [sessionId, toolName, actorUserId],
      )
      return result.rows[0]?.result ?? null
    },

    async set(sessionId, toolName, _input, result, expiryHours, actorUserId = null) {
      await query(
        `INSERT INTO tool_result_cache (session_id, tool_name, result, expires_at, actor_user_id)
         VALUES ($1, $2, $3, now() + make_interval(hours => $4), $5)`,
        [sessionId, toolName, JSON.stringify(result), expiryHours, actorUserId],
      )
    },
  }
}
