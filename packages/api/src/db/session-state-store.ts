import { bindScopeSources,boundScopeSources,type SessionStateRecord,type SessionStateStore } from '@use-brian/core'
import {
  upsertSessionState,
  resolveSessionState,
  listOpenSessionState,
  listRecentSessionState,
  purgeResolvedSessionState,
  type SessionStateRow,
} from './session-state-queries.js'

function toRecord(r: SessionStateRow): SessionStateRecord {
  return bindScopeSources({
    id: r.id,
    sessionId: r.sessionId,
    userId: r.userId,
    assistantId: r.assistantId,
    key: r.key,
    status: r.status,
    summary: r.summary,
    detail: r.detail,
    source: r.source,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    resolvedAt: r.resolvedAt,
  },boundScopeSources(r))
}

/**
 * Postgres-backed session_state store. Mirrors createDbEpisodicStore.
 */
export function createDbSessionStateStore(): SessionStateStore {
  return {
    async upsert(params) {
      const row = await upsertSessionState({
        sessionId: params.sessionId,
        userId: params.userId,
        assistantId: params.assistantId,
        key: params.key,
        summary: params.summary,
        detail: params.detail ?? null,
        source: params.source,
        authority: params.authority,
        derivation: params.derivation,
      })
      return toRecord(row)
    },

    async resolve(params) {
      const row = await resolveSessionState(params)
      return row ? toRecord(row) : null
    },

    async listOpenBySession(sessionId, authority) {
      const rows = await listOpenSessionState(sessionId, authority)
      return rows.map(toRecord)
    },

    async listRecentBySession(sessionId, limit, authority) {
      const rows = await listRecentSessionState(sessionId, limit, authority)
      return rows.map(toRecord)
    },

    async purgeResolvedOlderThan(sessionId, olderThan, authority) {
      return purgeResolvedSessionState(sessionId, olderThan, authority)
    },
  }
}
