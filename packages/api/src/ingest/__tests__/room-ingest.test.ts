/**
 * [COMP:api/room-ingest] — room ambient capture (multiplayer chat P2).
 *
 * A silent room post reaches the RULES ENGINE like any channel source, with
 * the room's workspace + clearance riding the decision:
 *
 *   - hosted (`scheduledBatching`) → the post lands in the room's hourly
 *     `(rule_id=sessionId, fires_at)` digest batch, sensitivity stamped from
 *     the room's `effective_clearance`;
 *   - OSS (no batch drain) → an inline Episode through the injected
 *     `BrainEpisodeIngestor`, `web_chat` + `room_post` provenance, clearance
 *     mapped onto the Episode tier (`confidential` → `private`).
 *
 * Spec: docs/architecture/brain/ingest-pipeline.md → "Source adapters" →
 * Room, and docs/architecture/features/chat-app.md → "Ambient capture".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRoomIngestor, ROOM_DIGEST_CRON, type RoomPostInput } from '../room-ingest.js'
import type { BrainEpisodeInput } from '../../ingest-port.js'
import type { appendBatchEvent as AppendBatchEvent } from '../../db/pending-ingest-batches-store.js'

const NOW = new Date('2026-07-31T10:20:00Z')

function post(over: Partial<RoomPostInput> = {}): RoomPostInput {
  return {
    sessionId: 's-room',
    workspaceId: 'ws-1',
    assistantId: 'a-1',
    senderUserId: 'u-alice',
    senderName: 'Alice',
    text: 'decision: we ship Friday, pending the QA pass',
    effectiveClearance: 'internal',
    ...over,
  }
}

describe('[COMP:api/room-ingest] room posts reach the rules engine (P2)', () => {
  const brainEpisodeIngestor = vi.fn(async (_input: BrainEpisodeInput) => ({}) as never)
  const appendBatchEvent = vi.fn<typeof AppendBatchEvent>(async () => {})

  beforeEach(() => {
    brainEpisodeIngestor.mockClear()
    appendBatchEvent.mockClear()
  })

  it('hosted: a post lands in the room-scoped hourly digest batch with workspace + clearance', async () => {
    const ingestor = createRoomIngestor({
      brainEpisodeIngestor,
      scheduledBatching: true,
      appendBatchEvent,
      now: () => NOW,
    })
    const result = await ingestor.ingestPost(post())
    expect(result).toEqual({ episodeId: null })
    expect(brainEpisodeIngestor).not.toHaveBeenCalled()
    expect(appendBatchEvent).toHaveBeenCalledTimes(1)
    const call = appendBatchEvent.mock.calls[0][0] as Record<string, unknown>
    expect(call).toMatchObject({
      workspaceId: 'ws-1',
      // The rule id IS the session id — the batch key windows per room.
      ruleId: 's-room',
      source: 'room',
      episodeSensitivity: 'internal',
    })
    // The hourly cron backstop: next top of the hour after "now".
    expect((call.firesAt as Date).toISOString()).toBe('2026-07-31T11:00:00.000Z')
    // The event the engine routed carries the attributed post.
    const event = call.event as { normalized: Record<string, unknown> }
    expect(event.normalized).toMatchObject({
      text: 'decision: we ship Friday, pending the QA pass',
      sender_name: 'Alice',
      session_id: 's-room',
    })
  })

  it('a confidential room stamps its clearance on the decision', async () => {
    const ingestor = createRoomIngestor({
      brainEpisodeIngestor,
      scheduledBatching: true,
      appendBatchEvent,
      now: () => NOW,
    })
    await ingestor.ingestPost(post({ effectiveClearance: 'confidential' }))
    expect(appendBatchEvent.mock.calls[0][0]).toMatchObject({
      episodeSensitivity: 'confidential',
    })
  })

  it('OSS: no batch drain — the post extracts inline with room provenance and the collapsed tier', async () => {
    const ingestor = createRoomIngestor({
      brainEpisodeIngestor,
      appendBatchEvent,
      now: () => NOW,
    })
    await ingestor.ingestPost(post({ effectiveClearance: 'confidential' }))
    expect(appendBatchEvent).not.toHaveBeenCalled()
    expect(brainEpisodeIngestor).toHaveBeenCalledTimes(1)
    expect(brainEpisodeIngestor.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws-1',
      userId: 'u-alice',
      assistantId: 'a-1',
      content: 'Alice: decision: we ship Friday, pending the QA pass',
      sourceKind: 'web_chat',
      // `confidential` collapses to the `private` Episode row tier.
      sensitivity: 'private',
      sourceRef: { source_kind: 'web_chat', session_id: 's-room', room_post: true },
    })
  })

  it('drops an empty post before the engine', async () => {
    const ingestor = createRoomIngestor({ brainEpisodeIngestor, appendBatchEvent })
    expect(await ingestor.ingestPost(post({ text: '   ' }))).toBeNull()
    expect(brainEpisodeIngestor).not.toHaveBeenCalled()
    expect(appendBatchEvent).not.toHaveBeenCalled()
  })

  it('the default room rule is the hourly always→scheduled digest', () => {
    expect(ROOM_DIGEST_CRON).toBe('0 * * * *')
  })
})
