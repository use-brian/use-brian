import { expect, vi } from 'vitest'
import type { IncomingMessageEventInput } from '../../message-events.js'
import { matchesEvent } from '../../../../core/src/workflow/event-trigger.js'

/** Check the actual workflow predicate, not just the producer's boolean mention gate. */
export async function expectMentionMatches(input: IncomingMessageEventInput, expected: string[]) {
  const { normalizeIncomingMessageEvent } = await vi.importActual<typeof import('../../message-events.js')>('../../message-events.js')
  const event = normalizeIncomingMessageEvent(input)
  expect(event.mentions).toEqual(expected)
  for (const id of expected) {
    expect(matchesEvent(event, { source: event.source, match: { mentions: [id] } })).toBe(true)
  }
  expect(matchesEvent(event, { source: event.source, match: { mentions: ['not-mentioned'] } })).toBe(false)
}
