/**
 * Room pin tools — `addPin` / `removePin` / `listPins`, the assistant's write
 * access to a shared room's Work Bench pin surface (the same `session_pins`
 * rows members manage from the UI).
 *
 * Injected PER TURN by the chat route, and ONLY for workspace-shared room
 * sessions — personal chats, channels, workflows, and workers never see these
 * (there is no pin surface to render there). Per the tool-awareness rule no
 * tool name appears in Layer 1; the model learns them from the injected
 * descriptions, and the pinned-context block keeps naming DATA only.
 *
 * Write semantics mirror the route (whoever can post can pin/unpin):
 *   - payload validation is the SAME `validateSessionPinPayload` the route
 *     uses, so the two write paths cannot drift;
 *   - a ref pin (page/task/contact/company/deal/file) must RESOLVE in the
 *     room's workspace at the session's clearance before it is written — a
 *     hallucinated or out-of-workspace id is rejected instead of becoming a
 *     junk "unavailable" chip;
 *   - an identical existing pin is answered idempotently, not duplicated;
 *   - every change emits `pins_changed` (attributed to the assistant) so all
 *     viewers' Work Bench rows refetch live.
 *
 * Spec: docs/architecture/features/chat-app.md → "Pinned room context (P1b)".
 * [COMP:api/room-pin-tools]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '@use-brian/core'
import {
  addSessionPin,
  listSessionPins,
  removeSessionPin,
  validateSessionPinPayload,
  PIN_KINDS,
  type SessionPin,
} from './db/session-pins-store.js'
import { resolveSessionPinLabels } from './resolve-session-pins.js'
import type { PublishSessionEvent } from './session-event-port.js'

export type SessionPinToolsDeps = {
  /** The room session the turn is running in. */
  sessionId: string
  workspaceId: string
  /** The session's `effective_clearance` — the label-resolution ceiling. */
  clearance: string | null
  /** The answering assistant — pin attribution. */
  assistantId: string
  publishSessionEvent: PublishSessionEvent
}

const addPinInputSchema = z.object({
  kind: z
    .enum(PIN_KINDS)
    .describe('What is being pinned. Brain items pin by refId; url and instruction carry their own payload.'),
  refId: z
    .string()
    .uuid()
    .optional()
    .describe('The id of the page/task/contact/company/deal/file to pin. Use real ids from this workspace (from listings or search results), never invented ones.'),
  url: z.string().optional().describe('The http(s) link to pin, when kind is "url".'),
  text: z
    .string()
    .optional()
    .describe('The standing background instruction to pin, when kind is "instruction" (2000 chars max).'),
})

function describePin(pin: SessionPin, label: string | null): string {
  const payload =
    pin.kind === 'url' ? pin.url ?? '' : pin.kind === 'instruction' ? pin.text ?? '' : label ?? pin.refId ?? ''
  return `${pin.kind} "${payload}"`
}

export function createSessionPinTools(deps: SessionPinToolsDeps): {
  addPin: Tool
  removePin: Tool
  listPins: Tool
} {
  const addPin = buildTool({
    name: 'addPin',
    description:
      'Pin an item to this room\'s shared Pins panel so it stays part of the conversation\'s working frame for everyone: a page, task, contact, company, deal, or file by its id, a URL, or a freeform background instruction. Pin items one call at a time. Use when asked to pin something, or when it would clearly help the room keep working context at hand.',
    inputSchema: addPinInputSchema,
    isReadOnly: false,
    isConcurrencySafe: false,
    async execute(input) {
      const payload = validateSessionPinPayload(input)
      if (!payload.ok) return { data: payload.error, isError: true }

      // A ref must resolve in THIS workspace at the room's clearance before it
      // becomes a row — reject unknown ids instead of pinning junk.
      let label: string | null = null
      if (payload.refId) {
        const candidate: SessionPin = {
          id: 'candidate',
          sessionId: deps.sessionId,
          kind: payload.kind,
          refId: payload.refId,
          url: null,
          text: null,
          position: 0,
          addedByUserId: null,
          addedByAssistantId: null,
          createdAt: new Date(),
        }
        const labels = await resolveSessionPinLabels([candidate], deps.workspaceId, deps.clearance)
        label = labels.get('candidate') ?? null
        if (label === null) {
          return {
            data: `No ${payload.kind} with id ${payload.refId} is readable in this workspace at this room's clearance. Pin only ids you obtained from listings or search results.`,
            isError: true,
          }
        }
      }

      // Idempotent: pinning what is already pinned answers with the existing
      // pin instead of stacking duplicates.
      const existing = (await listSessionPins(deps.sessionId)).find(
        (p) =>
          p.kind === payload.kind &&
          p.refId === payload.refId &&
          p.url === payload.url &&
          p.text === payload.text,
      )
      if (existing) {
        return { data: `Already pinned: ${describePin(existing, label)} (pin id: ${existing.id}).` }
      }

      const pin = await addSessionPin({
        sessionId: deps.sessionId,
        kind: payload.kind,
        refId: payload.refId,
        url: payload.url,
        text: payload.text,
        addedByAssistantId: deps.assistantId,
      })
      deps.publishSessionEvent({
        kind: 'pins_changed',
        sessionId: deps.sessionId,
        payload: { byAssistantId: deps.assistantId },
      })
      return { data: `Pinned ${describePin(pin, label)} (pin id: ${pin.id}).` }
    },
  })

  const removePin = buildTool({
    name: 'removePin',
    description:
      'Remove a pin from this room\'s shared Pins panel by its pin id (find pin ids with listPins). Anyone in the room can unpin any pin; do it when asked, or when a pinned item is clearly stale.',
    inputSchema: z.object({
      pinId: z.string().uuid().describe('The pin id (NOT the pinned item\'s id).'),
    }),
    isReadOnly: false,
    isConcurrencySafe: true,
    async execute(input) {
      const removed = await removeSessionPin(deps.sessionId, input.pinId)
      if (!removed) {
        return { data: `No pin ${input.pinId} in this room. Check listPins for current pin ids.`, isError: true }
      }
      deps.publishSessionEvent({
        kind: 'pins_changed',
        sessionId: deps.sessionId,
        payload: { byAssistantId: deps.assistantId },
      })
      return { data: `Unpinned ${input.pinId}.` }
    },
  })

  const listPins = buildTool({
    name: 'listPins',
    description:
      'List this room\'s current pins with their pin ids (needed for removePin). The pinned items themselves are already summarized in your context each turn.',
    inputSchema: z.object({}),
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute() {
      const pins = await listSessionPins(deps.sessionId)
      if (pins.length === 0) return { data: 'This room has no pins.' }
      const labels = await resolveSessionPinLabels(pins, deps.workspaceId, deps.clearance)
      const lines = pins.map((pin) => {
        const label = labels.get(pin.id) ?? null
        const body =
          pin.kind === 'instruction'
            ? (pin.text ?? '').slice(0, 120)
            : pin.kind === 'url'
              ? pin.url ?? ''
              : label ?? '(unavailable at this room\'s clearance)'
        return `- [pin id: ${pin.id}] ${pin.kind}: ${body}`
      })
      return { data: lines.join('\n') }
    },
  })

  return { addPin, removePin, listPins }
}
