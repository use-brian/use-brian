/**
 * [COMP:api/turn-frame-contract] The chat stream frames the API emits match
 * the client boundary schema in `apps/app-web/src/lib/chat/turn-frames.ts`
 * (read-only here; the client owns it).
 *
 * Direct stream: every `sendEvent` / `sendActivityEvent` /
 * `sendControlActivityEvent` site in `routes/chat.ts`. Follow stream: every
 * `send(...)` in `GET /api/sessions/:id/stream` plus the pure reconnect relay
 * and backstop frames in `routes/sessions.ts`, which are also run through the
 * client's own `classifyTurnFrame`. Names are compared in both directions and
 * each emission site's literal payload must carry the client's required fields.
 *
 * KNOWN_MISMATCHES is empty: the comparison is exact, so any new drift fails.
 * Server-owned rules checked here as well: every literal direct `notice`
 * carries `code` (kind-only notices also carry `code` equal to their `kind`),
 * and the follow stream relays the bus kind under the server's name
 * `assistant_changed`, never `session_assistant_changed`.
 * Spec: docs/architecture/engine/turn-kernel.md "Sinks".
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { reconnectBackstopFrames, reconnectRelayFrames } from '../sessions.js'
import { recordingParticipantsUpdatedReceipt } from '../chat.js'
import type { SessionEvent } from '../../session-event-port.js'

const clientUrl = new URL('../../../../../apps/app-web/src/lib/chat/turn-frames.ts', import.meta.url)
const clientSource = readFileSync(clientUrl, 'utf8')
const chatSource = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8')
const sessionsSource = readFileSync(new URL('../sessions.ts', import.meta.url), 'utf8')
type Stream = 'direct' | 'follow'
const client = await import(/* @vite-ignore */ clientUrl.href) as {
  TURN_FRAME_NAMES: Record<Stream, readonly string[]>
  classifyTurnFrame: (stream: Stream, event: string, data: unknown) => { class: string; ignored?: string }
}

/** Reported mismatches. Empty since the client aligned to the server on
 * 2026-11-16; any new drift in either direction fails the exact comparison. */
const KNOWN_MISMATCHES: string[] = []

/** Payload variables produced by a typed function rather than a literal; each
 * producer is exercised below through the client classifier. */
const TYPED_PRODUCERS = new Map([
  ['notice', 'postReplyNotice = AssistantTurn.notice(): { code, message } | null'],
  ['recording_participants_updated', 'recordingReceipt = recordingParticipantsUpdatedReceipt(): { recordingId, pageId? } | null'],
])

/** Balanced `{...}` starting at `open` (string/template contents are skipped). */
function braced(source: string, open: number): string {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const ch = source[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      for (i++; i < source.length && source[i] !== quote; i++) if (source[i] === '\\') i++
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return source.slice(open, i + 1)
  }
  return source.slice(open)
}

/** Top-level keys of an object literal, including shorthand and spreads. */
function literalKeys(literal: string): { keys: Set<string>; spreads: boolean } {
  const body = literal.slice(1, -1)
  const keys = new Set<string>()
  let depth = 0, token = ''
  const flush = () => {
    const part = token.trim(); token = ''
    if (!part) return
    if (part.startsWith('...')) { keys.add('...'); return }
    const key = /^['"]?([A-Za-z_$][\w$]*)['"]?\s*(?::|$)/.exec(part)?.[1]
    if (key) keys.add(key)
  }
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch; token += ch
      for (i++; i < body.length && body[i] !== quote; i++) { token += body[i]; if (body[i] === '\\') token += body[++i] }
      token += quote; continue
    }
    if ('{[('.includes(ch!)) depth++
    if ('}])'.includes(ch!)) depth--
    if (ch === ',' && depth === 0) { flush(); continue }
    token += ch
  }
  flush()
  return { keys: new Set([...keys].filter(key => key !== '...')), spreads: keys.has('...') }
}

/** Client required fields per frame, from its own declarations. */
function clientRequired(): Record<Stream, Map<string, string[]>> {
  const schemas = new Map<string, string>()
  for (const match of clientSource.matchAll(/const (\w+) = (payload\(\{[^\n]*\}\)|record);/g)) schemas.set(match[1]!, match[2]!)
  const required = (schema: string): string[] => {
    const resolved = schemas.get(schema.trim()) ?? schema
    const inner = /payload\(\{(.*)\}\)/.exec(resolved)?.[1]
    if (!inner) return []
    return [...inner.matchAll(/(\w+): ([^,]+(?:\([^)]*\))?[^,]*)/g)]
      .filter(([, , type]) => !/optString|optBool|\.optional\(\)/.test(type!)).map(([, key]) => key!)
  }
  const block = (name: string) => {
    const start = clientSource.indexOf(`const ${name}`)
    return braced(clientSource, clientSource.indexOf('{', clientSource.indexOf('=', start)))
  }
  const frames = (text: string) => new Map([...text.matchAll(/^\s*(\w+): \{ class: "\w+(?:-\w+)?", schema: (.+) \},$/gm)]
    .map(([, name, schema]) => [name!, required(schema!)] as const))
  const shared = frames(block('shared'))
  return { direct: new Map([...shared, ...frames(block('DIRECT_FRAMES'))]), follow: new Map([...shared, ...frames(block('FOLLOW_FRAMES'))]) }
}

type Site = { name: string; keys: Set<string> | null; spreads: boolean; label: string }
/** Every direct-stream emission site in the web chat route. */
function directSites(): Site[] {
  const sites: Site[] = []
  for (const match of chatSource.matchAll(/send(?:Activity|ControlActivity)?Event\(\s*'([a-z_]+)',\s*/g)) {
    const at = match.index! + match[0].length
    const name = match[1]!
    let literal: string | null = null
    if (chatSource[at] === '{') literal = braced(chatSource, at)
    else {
      const id = /^[A-Za-z_$][\w$]*/.exec(chatSource.slice(at))?.[0]
      const declaration = id ? chatSource.lastIndexOf(`const ${id} = {`, at) : -1
      if (declaration >= 0) literal = braced(chatSource, chatSource.indexOf('{', declaration))
    }
    const parsed = literal ? literalKeys(literal) : null
    const kind = literal ? /kind:\s*'([a-z_]+)'/.exec(literal)?.[1] : undefined
    sites.push({ name, keys: parsed?.keys ?? null, spreads: parsed?.spreads ?? true, label: kind ? `${name} {kind:${kind}}` : name })
  }
  return sites
}

/** Follow-stream names: the room relay switch, the reconnect relay and backstop. */
function followNames(): Set<string> {
  const route = sessionsSource.slice(sessionsSource.indexOf("router.get('/:id/stream'"))
  const names = new Set([...route.matchAll(/\bsend\(\s*'([a-z_]+)'/g)].map(match => match[1]!))
  const relay = sessionsSource.slice(sessionsSource.indexOf('export function reconnectRelayFrames'), sessionsSource.indexOf('export function sessionRoutes'))
  for (const match of relay.matchAll(/event:\s*'([a-z_]+)'/g)) names.add(match[1]!)
  return names
}

describe('[COMP:api/turn-frame-contract] server frames match the client turn-frame schema', () => {
  const required = clientRequired()

  it('parses the client schema it compares against', () => {
    expect([...required.direct.keys()].sort()).toEqual([...client.TURN_FRAME_NAMES.direct].sort())
    expect([...required.follow.keys()].sort()).toEqual([...client.TURN_FRAME_NAMES.follow].sort())
    expect(required.direct.get('tool_start')).toEqual(['id', 'name'])
    // The client's notice schema requires `code` or `kind` through a refine,
    // which the declaration scan reads as no required field.
    expect(required.direct.get('notice')).toEqual([])
    expect(client.TURN_FRAME_NAMES.follow).toContain('assistant_changed')
    expect(client.TURN_FRAME_NAMES.follow).not.toContain('session_assistant_changed')
  })

  it('runs the actual reconnect relay and backstop frames through the client classifier', () => {
    const events: SessionEvent[] = [
      { kind: 'turn_stream', sessionId: 's', payload: { text: 'Fictional', activity: null, turnId: 't' } },
      { kind: 'turn_activity', sessionId: 's', payload: { event: 'tool_start', id: 'call', name: 'lookup', turnId: 't' } },
      { kind: 'pins_changed', sessionId: 's', payload: { byUserId: 'u' } },
      { kind: 'turn_completed', sessionId: 's', payload: { senderUserId: 'u', turnId: 't', reason: 'failed' } },
    ]
    const frames = [...events.flatMap(event => reconnectRelayFrames(event, 't').frames), ...reconnectBackstopFrames('failed', 't', 'failed')]
    expect(frames.length).toBeGreaterThan(4)
    for (const frame of frames) expect(client.classifyTurnFrame('follow', frame.event, frame.data), frame.event).not.toMatchObject({ class: 'ignorable' })
  })

  it('classifies the typed payload producers the static scan cannot read', () => {
    const receipt = recordingParticipantsUpdatedReceipt({ name: 'assignRecordingSpeakers',
      content: JSON.stringify({ kind: 'recording_speakers_assigned', recordingId: 'fictional-recording' }) })
    expect(client.classifyTurnFrame('direct', 'recording_participants_updated', receipt)).not.toMatchObject({ class: 'ignorable' })
    // The post-reply notice is the owner's typed `{ code, message }`.
    const notice = { code: 'post_reply_authority_changed', message: 'Fictional notice' }
    expect(client.classifyTurnFrame('direct', 'notice', notice)).toMatchObject({ class: 'notice' })
  })

  it('emits exactly the client frame names and their required fields, apart from the reported mismatches', () => {
    const mismatches: string[] = []
    const sites = directSites()
    expect(sites.length).toBeGreaterThan(80)
    const direct = new Set(sites.map(site => site.name)), follow = followNames()
    for (const [stream, emitted] of [['direct', direct], ['follow', follow]] as const) {
      const known = new Set(client.TURN_FRAME_NAMES[stream])
      for (const name of emitted) if (!known.has(name)) mismatches.push(`${stream}: server emits ${name}, client lacks it`)
      for (const name of known) if (!emitted.has(name)) mismatches.push(`${stream}: client lists ${name}, server never emits it`)
    }
    for (const site of sites) {
      const fields = required.direct.get(site.name) ?? []
      // An unresolved payload variable is listed; a spread never counts as supplying a required field.
      if (!site.keys && fields.length) { if (!TYPED_PRODUCERS.has(site.name)) mismatches.push(`direct: ${site.label} payload is not a resolvable literal`); continue }
      const missing = site.keys ? fields.filter(field => !site.keys!.has(field)) : []
      if (missing.length) mismatches.push(`direct: ${site.label} lacks required ${missing.join(',')}${site.spreads ? ' (spread payload)' : ''}`)
    }
    expect([...new Set(mismatches)].sort()).toEqual(KNOWN_MISMATCHES)
  })

  it('gives every literal direct notice a code, equal to its kind when it has one', () => {
    const notices = directSites().filter(site => site.name === 'notice' && site.keys)
    expect(notices.length).toBeGreaterThanOrEqual(7)
    for (const site of notices) expect(site.keys!.has('code'), site.label).toBe(true)
    const kinds = [...chatSource.matchAll(/sendEvent\('notice',\s*\{([^}]*)\}/g)].map(match => match[1]!)
      .filter(body => /\bkind:/.test(body))
    expect(kinds.length).toBe(4)
    for (const body of kinds) {
      const kind = /\bkind:\s*'([a-z_]+)'/.exec(body)?.[1]
      expect(/\bcode:\s*'([a-z_]+)'/.exec(body)?.[1], body).toBe(kind)
      expect(client.classifyTurnFrame('direct', 'notice', { code: kind, kind, message: 'Fictional' })).toMatchObject({ class: 'notice' })
    }
    expect(followNames().has('assistant_changed')).toBe(true)
    expect(followNames().has('session_assistant_changed')).toBe(false)
  })
})
