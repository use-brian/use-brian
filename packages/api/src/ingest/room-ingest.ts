/**
 * Room ambient capture — the ingest producer for workspace chat rooms
 * (multiplayer chat P2/D3/D9; docs/plans/multiplayer-chat.md).
 *
 * "The brain hears the room": silent teammate posts (the T2 post path — the
 * messages that never run a turn) flow into the brain-ingest pipeline like
 * any channel source. Addressed turns already reach the brain through
 * Pipeline A (chat compaction); this producer covers the exchange that
 * happens BETWEEN turns, which is exactly the differentiator the room model
 * exists for — decisions, tasks and facts from the jam land in the company
 * brain without anyone dictating minutes.
 *
 * Mirrors the WhatsApp inbound producer's architecture
 * (`whatsapp-ingest.ts`), with two deliberate differences:
 *
 *   1. Rooms have no `connector_instance`, so the rules are an in-memory
 *      per-room default set routed through the SAME `createIngestEngine`
 *      (first-match-wins, universal filters) — `always → scheduled` on an
 *      hourly digest cron. The synthetic rule id is the SESSION id, so the
 *      `(rule_id, fires_at)` batch key windows per room.
 *   2. Extraction composes over the injected `BrainEpisodeIngestor` (the
 *      same seam brain-MCP / doc distillation use) instead of carrying its
 *      own Pipeline-B dep graph.
 *
 * Routing follows the engine decision:
 *   - `scheduled` + hosted batching → `appendBatchEvent`; the per-room
 *     `(rule_id, fires_at)` batch IS the window, drained by the batch worker
 *     into ONE digest Episode (the WhatsApp window precedent). Default
 *     posture — a busy hour of posts costs one extraction (§6).
 *   - `scheduled` without a batch drain (OSS) → inline single-post Episode,
 *     the WhatsApp OSS fallback.
 *   - `drop` / no-match / empty text → discarded.
 *
 * Clearance-aware (D9): the room's `effective_clearance` rides the decision
 * as the Episode sensitivity (`confidential` collapses to the `private` row
 * tier), so captured facts never widen past the room's read floor. Capture
 * is always-on with a permanent room-header indicator — no silent capture.
 *
 * [COMP:api/room-ingest]
 */

import {
  composeFilters,
  computeNextRun,
  createIngestEngine,
  universalFilters,
  type IngestEngine,
  type IngestEvent,
  type IngestRule,
} from '@use-brian/core'
import { appendBatchEvent } from '../db/pending-ingest-batches-store.js'
import { resolveIngestPlaceholders } from './placeholder-resolver.js'
import type { BrainEpisodeIngestor } from '../ingest-port.js'
import type { EpisodeSensitivity } from '../db/episodes-store.js'

/** Hourly digest backstop — the room window's cron (cost posture §6). */
export const ROOM_DIGEST_CRON = '0 * * * *'

export type RoomPostInput = {
  sessionId: string
  workspaceId: string
  assistantId: string
  senderUserId: string
  senderName: string | null
  text: string
  /** The room's `effective_clearance` — the capture ceiling. */
  effectiveClearance: string | null
}

export type RoomIngestor = {
  /**
   * Route one room post through the room's rules. Resolves to
   * `{ episodeId }` when an inline Episode ran, `null` for scheduled
   * enqueues, drops, and empty posts. Fire-and-forget at the call site —
   * a capture failure must never break posting.
   */
  ingestPost: (input: RoomPostInput) => Promise<{ episodeId: string | null } | null>
}

export type RoomIngestorDeps = {
  /** The Pipeline-B episode seam (open or hosted impl). */
  brainEpisodeIngestor: BrainEpisodeIngestor
  /**
   * True when a batch worker drains `pending_ingest_batches` in this
   * deployment (hosted). False (OSS default) executes scheduled matches as
   * inline single-post Episodes — the WhatsApp OSS fallback.
   */
  scheduledBatching?: boolean
  /** Test seam — defaults to `appendBatchEvent`. */
  appendBatchEvent?: typeof appendBatchEvent
  /** Test seam — defaults to `() => new Date()`. */
  now?: () => Date
}

/** Room clearance → the 3-tier decision sensitivity. */
function toDecisionSensitivity(
  clearance: string | null,
): 'public' | 'internal' | 'confidential' {
  return clearance === 'public' || clearance === 'confidential' ? clearance : 'internal'
}

/** Decision sensitivity → the 4-tier Episode row sensitivity. */
function toEpisodeSensitivity(
  s: 'public' | 'internal' | 'confidential',
): EpisodeSensitivity {
  return s === 'confidential' ? 'private' : s
}

/**
 * The per-room in-memory default rule set: capture everything, on the hourly
 * digest window, at the room's clearance. Deliberately no DB rules — rooms
 * have no `connector_instance`; a per-room rules surface is a later product
 * question (the D9 lock is capture-always-on, no per-room toggle).
 */
export function buildRoomIngestEngine(
  sessionId: string,
  clearance: 'public' | 'internal' | 'confidential',
): IngestEngine {
  const rules: IngestRule[] = [
    {
      id: sessionId,
      connector_instance_id: sessionId,
      source: 'room',
      rule_order: 0,
      filter_type: 'always',
      filter_params: {},
      routing_mode: 'scheduled',
      routing_schedule: ROOM_DIGEST_CRON,
      routing_timezone: 'UTC',
      alert: false,
      episode_sensitivity: clearance,
    },
  ]
  return createIngestEngine({
    rules: { listByConnectorInstance: async () => rules },
    filters: composeFilters(universalFilters, {}),
    batches: { appendEvent: async () => {} },
    pipelineB: { process: async () => ({ episodeId: null }) },
    // The default room rule carries no placeholder params; the standard
    // workspace-scoped resolver keeps the engine contract satisfied.
    resolvePlaceholders: resolveIngestPlaceholders,
  })
}

function buildIngestEvent(input: RoomPostInput): IngestEvent {
  return {
    source: 'room',
    normalized: {
      // Universal-filter substrate + what the generic episode builder and
      // the digest aggregation read.
      text: input.text,
      actor_id: input.senderUserId,
      sender: input.senderName ?? input.senderUserId,
      sender_name: input.senderName,
      session_id: input.sessionId,
      posted_at: new Date().toISOString(),
      mentions: [],
      user_flags: [],
    },
  }
}

export function createRoomIngestor(deps: RoomIngestorDeps): RoomIngestor {
  const appendEvent = deps.appendBatchEvent ?? appendBatchEvent
  const now = deps.now ?? (() => new Date())

  return {
    async ingestPost(input: RoomPostInput) {
      const text = input.text.trim()
      if (!text) return null

      const clearance = toDecisionSensitivity(input.effectiveClearance)
      const engine = buildRoomIngestEngine(input.sessionId, clearance)
      const event = buildIngestEvent(input)
      const decision = await engine.ingest(event, {
        workspace_id: input.workspaceId,
        connector_instance_id: input.sessionId,
      })

      if (!decision.matched || decision.rule_id === null) return null
      if (decision.routing_mode === 'drop') return null

      const sensitivity = decision.episode_sensitivity ?? clearance

      if (decision.routing_mode === 'scheduled' && deps.scheduledBatching) {
        const firesAt = decision.schedule
          ? computeNextRun(
              { type: 'cron', expression: decision.schedule },
              decision.timezone || 'UTC',
              now(),
            )
          : now()
        await appendEvent({
          workspaceId: input.workspaceId,
          ruleId: decision.rule_id,
          source: 'room',
          firesAt,
          event,
          episodeSensitivity: sensitivity,
        })
        return { episodeId: null }
      }

      // Inline single-post Episode (OSS fallback / realtime rules). Same
      // `web_chat` source family as Pipeline A so downstream provenance
      // reads uniformly; `room_post` marks the ambient path.
      await deps.brainEpisodeIngestor({
        workspaceId: input.workspaceId,
        userId: input.senderUserId,
        assistantId: input.assistantId,
        content: `${input.senderName ?? 'A teammate'}: ${text}`,
        occurredAt: now(),
        sensitivity: toEpisodeSensitivity(sensitivity),
        sourceKind: 'web_chat',
        sourceRef: {
          source_kind: 'web_chat',
          session_id: input.sessionId,
          room_post: true,
        },
      })
      return { episodeId: null }
    },
  }
}
