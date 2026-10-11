import { describe, expect, it } from 'vitest'
import { classifySession, isTuningSession, type SessionKindRow } from '../session-kind.js'

/**
 * Every session shape in the wild (docs/plans/unified-sessions.md section 2.1)
 * classifies to exactly one SessionKind.
 */
describe('[COMP:api/session-kind] classifySession', () => {
  const shapes: Array<[string, SessionKindRow, ReturnType<typeof classifySession>]> = [
    ['personal web chat', { channelType: 'web', anchorKind: null, visibility: 'owner', appOrigin: 'chat', channelId: 'c1' },
      { audience: 'personal', anchor: { kind: 'none', ref: null }, transport: 'web', lane: 'conversation', machine: null, surface: 'chat' }],
    ['doc dock', { channelType: 'web', anchorKind: null, visibility: 'owner', appOrigin: 'doc', channelId: 'c1' },
      { audience: 'personal', anchor: { kind: 'none', ref: null }, transport: 'web', lane: 'conversation', machine: null, surface: 'doc' }],
    ['workspace room', { channelType: 'web', anchorKind: null, visibility: 'workspace', appOrigin: 'chat', channelId: 'r1' },
      { audience: 'workspace', anchor: { kind: 'none', ref: null }, transport: 'web', lane: 'conversation', machine: null, surface: 'chat' }],
    ['feed draft', { channelType: 'web', anchorKind: null, visibility: 'workspace', mode: 'draft', channelId: 'draft:1' },
      { audience: 'workspace', anchor: { kind: 'feed_draft', ref: 'draft:1' }, transport: 'web', lane: 'conversation', machine: null, surface: null }],
    ['platform feed draft (owner visibility)', { channelType: 'web', anchorKind: null, visibility: 'owner', mode: 'draft', channelId: 'draft:2' },
      { audience: 'workspace', anchor: { kind: 'feed_draft', ref: 'draft:2' }, transport: 'web', lane: 'conversation', machine: null, surface: null }],
    ['doc comment thread', { channelType: 'doc_thread', anchorKind: null, visibility: 'workspace', channelId: 't1' },
      { audience: 'workspace', anchor: { kind: 'doc_thread', ref: 't1' }, transport: 'web', lane: 'conversation', machine: null, surface: null }],
    ['office file thread', { channelType: 'office_thread', anchorKind: null, visibility: 'workspace', channelId: 'o1' },
      { audience: 'workspace', anchor: { kind: 'office_file', ref: 'o1' }, transport: 'web', lane: 'conversation', machine: null, surface: null }],
    ['feed thread', { channelType: 'feed_thread', anchorKind: null, visibility: 'workspace', channelId: 'feed-thread:9' },
      { audience: 'workspace', anchor: { kind: 'feed_thread', ref: 'feed-thread:9' }, transport: 'web', lane: 'conversation', machine: null, surface: null }],
    ['external DM', { channelType: 'telegram', anchorKind: null, visibility: 'owner', channelId: '12345' },
      { audience: 'personal', anchor: { kind: 'none', ref: null }, transport: 'telegram', lane: 'conversation', machine: null, surface: null }],
    ['notification inbox', { channelType: 'notification', anchorKind: null, visibility: 'owner', channelId: 'notifications' },
      { audience: 'personal', anchor: { kind: 'inbox', ref: 'notifications' }, transport: 'web', lane: 'conversation', machine: null, surface: null }],
    ['inbox sentinel on an external channel', { channelType: 'telegram', anchorKind: null, visibility: 'owner', channelId: 'notifications' },
      { audience: 'personal', anchor: { kind: 'inbox', ref: null }, transport: 'telegram', lane: 'conversation', machine: null, surface: null }],
  ]
  for (const [name, row, expected] of shapes) {
    it(`classifies ${name}`, () => {
      expect(classifySession(row)).toEqual(expected)
    })
  }

  const machines: Array<[string, SessionKindRow, string]> = [
    ['A2A callee', { channelType: 'assistant-call', anchorKind: null, channelId: 'x' }, 'a2a'],
    ['workflow run', { channelType: 'workflow', anchorKind: null, channelId: 'run-1' }, 'workflow'],
    ['public API', { channelType: 'api', anchorKind: null, channelId: 'k' }, 'api'],
    ['brain inspection', { channelType: 'brain_inspection', anchorKind: null, channelId: 'i', transient: true }, 'inspection'],
    ['brain edit', { channelType: 'brain_edit', anchorKind: null, channelId: 'e', transient: true }, 'brain_edit'],
    ['legacy cron', { channelType: 'cron', anchorKind: null, channelId: 'j' }, 'cron'],
  ]
  for (const [name, row, machine] of machines) {
    it(`classifies ${name} as a machine lane`, () => {
      const kind = classifySession(row)
      expect(kind.lane).toBe('machine')
      expect(kind.machine).toBe(machine)
    })
  }

  it('anchors workflow and cron runs to a job', () => {
    expect(classifySession({ channelType: 'workflow', anchorKind: null, channelId: 'run-1' }).anchor).toEqual({ kind: 'job', ref: 'run-1' })
  })

  it('treats a transient row on an unknown channel as a machine lane', () => {
    expect(classifySession({ channelType: 'web', anchorKind: null, channelId: 'x', transient: true }).lane).toBe('machine')
  })

  // Migration 741 stores the anchor and moves anchored web threads to the
  // web transport: the stored anchor is authoritative.
  const stored: Array<[string, SessionKindRow, string, string]> = [
    ['doc thread', { channelType: 'web', anchorKind: 'doc_thread', anchorRef: 'ct-1', visibility: 'workspace' }, 'doc_thread', 'workspace'],
    ['office file thread', { channelType: 'web', anchorKind: 'office_file', anchorRef: 'art-1', visibility: 'workspace' }, 'office_file', 'workspace'],
    ['feed thread', { channelType: 'web', anchorKind: 'feed_thread', visibility: 'workspace' }, 'feed_thread', 'workspace'],
    ['feed draft', { channelType: 'web', anchorKind: 'feed_draft', visibility: 'workspace', mode: 'draft' }, 'feed_draft', 'workspace'],
    ['inbox', { channelType: 'web', anchorKind: 'inbox', visibility: 'personal', channelId: 'notifications' }, 'inbox', 'personal'],
    ['converged channel room', { channelType: 'telegram', anchorKind: 'channel', visibility: 'workspace', channelId: '-100' }, 'channel', 'workspace'],
    ['personal chat', { channelType: 'web', anchorKind: 'none', visibility: 'personal', appOrigin: 'chat' }, 'none', 'personal'],
  ]
  for (const [name, row, anchor, audience] of stored) {
    it(`classifies a stored ${name} by its anchor column`, () => {
      const kind = classifySession(row)
      expect(kind.anchor.kind).toBe(anchor)
      expect(kind.audience).toBe(audience)
    })
  }

  it('keeps the anchor reference', () => {
    expect(classifySession({ channelType: 'web', anchorKind: 'office_file', anchorRef: 'art-1', visibility: 'workspace' }).anchor)
      .toEqual({ kind: 'office_file', ref: 'art-1' })
  })

  it('recognizes the tuning sentinel', () => {
    expect(isTuningSession({ channelId: 'tuning' })).toBe(true)
    expect(isTuningSession({ channelId: 'abc' })).toBe(false)
  })
})
