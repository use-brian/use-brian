import type { EpisodicStore, EpisodicMemoryRecord } from '@use-brian/core'
import {
  createEpisodicMemory,
  fetchEpisodicByTopic,
  fetchEpisodicBySession,
  listEpisodicTopicsBySession,
  listEpisodicBySession,
  deleteEpisodicById,
  incrementEpisodicSurvivalCount,
  type EpisodicMemoryRow,
} from './episodic-memories.js'

function toRecord(r: EpisodicMemoryRow): EpisodicMemoryRecord {
  return {
    id: r.id,
    userId: r.userId,
    assistantId: r.assistantId,
    sessionId: r.sessionId,
    topicLabel: r.topicLabel,
    summary: r.summary,
    messageSpan: r.messageSpan,
    entityRefs: r.entityRefs,
    createdAt: r.createdAt,
    lastAccessedAt: r.lastAccessedAt,
    accessCount: r.accessCount,
    survivalCount: r.survivalCount,
  }
}

/**
 * Create an EpisodicStore backed by PostgreSQL.
 * Adapts the DB functions to the core package's EpisodicStore interface.
 */
export function createDbEpisodicStore(): EpisodicStore {
  return {
    async create(params) {
      const row = await createEpisodicMemory(params)
      return toRecord(row)
    },

    async fetchByTopic(params) {
      const rows = await fetchEpisodicByTopic(params)
      return rows.map(toRecord)
    },

    async fetchBySession(params) {
      const rows = await fetchEpisodicBySession(params)
      return rows.map(toRecord)
    },

    async listTopicsBySession(params) {
      return listEpisodicTopicsBySession(params)
    },

    async listBySession(sessionId) {
      const rows = await listEpisodicBySession(sessionId)
      return rows.map(toRecord)
    },

    async deleteById(id) {
      await deleteEpisodicById(id)
    },

    async incrementSurvivalCount(ids) {
      await incrementEpisodicSurvivalCount(ids)
    },
  }
}
