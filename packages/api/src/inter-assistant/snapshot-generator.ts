/**
 * Snapshot generator — reads current data from DB and saves a frozen copy.
 *
 * No LLM, no sessions, no MCP. Just direct DB reads.
 */

import { query } from '../db/client.js'
import type { SnapshotStore } from '../db/snapshot-store.js'

export type SnapshotGeneratorOptions = {
  snapshotStore: SnapshotStore
}

export function createSnapshotGenerator({ snapshotStore }: SnapshotGeneratorOptions) {
  return async function generateSnapshot(
    assistantId: string,
    userId: string,
    category: string,
  ): Promise<string> {
    let content: Record<string, unknown>

    switch (category) {
      case 'knowledge': {
        const result = await query<{ id: string; path: string; title: string; summary: string | null; tags: string[] }>(
          `SELECT id, path, title, summary, tags FROM knowledge_entries
           WHERE assistant_id = $1 ORDER BY path ASC LIMIT 100`,
          [assistantId],
        )
        content = {
          entries: result.rows,
          count: result.rows.length,
        }
        break
      }

      case 'tasks': {
        const result = await query<{
          id: string; instructions: string; schedule: unknown;
          timezone: string; enabled: boolean; nextRunAt: string | null
        }>(
          `SELECT id, instructions, schedule, timezone, enabled,
                  next_run_at AS "nextRunAt"
           FROM scheduled_jobs
           WHERE assistant_id = $1 AND user_id = $2
           ORDER BY created_at DESC LIMIT 50`,
          [assistantId, userId],
        )
        content = {
          jobs: result.rows,
          count: result.rows.length,
        }
        break
      }

      case 'memories': {
        const result = await query<{
          id: string; type: string; summary: string; tags: string[]
        }>(
          `SELECT id, type, summary, tags FROM memories
           WHERE assistant_id = $1 AND user_id = $2
           ORDER BY updated_at DESC LIMIT 50`,
          [assistantId, userId],
        )
        content = {
          memories: result.rows,
          count: result.rows.length,
        }
        break
      }

      case 'calendar': {
        // Calendar data lives in Google Calendar (MCP), not in our DB.
        // Snapshot stores a timestamp — the live query is needed for actual data.
        content = {
          note: 'Calendar data requires live access. Set freshness to "live" for calendar sharing.',
        }
        break
      }

      default: {
        content = { note: `Unknown category: ${category}` }
      }
    }

    // Save as draft and auto-publish
    const draft = await snapshotStore.generateDraft(assistantId, category, {
      ...content,
      generatedAt: new Date().toISOString(),
      category,
    })
    const published = await snapshotStore.publish(userId, draft.id)

    const summary = category === 'calendar'
      ? 'Calendar requires live access.'
      : `Snapshot saved: ${(content as { count?: number }).count ?? 0} entries.`

    return summary
  }
}
