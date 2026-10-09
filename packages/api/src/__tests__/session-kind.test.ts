import { describe, expect, it } from 'vitest'
import { classifySession, isTuningSession, type SessionKindRow } from '../session-kind.js'

/**
 * Every session shape in the wild (docs/plans/unified-sessions.md section 2.1)
 * classifies to exactly one SessionKind.
 */
describe('[COMP:api/session-kind] classifySession', () => {
  const shapes: Array<[string, SessionKindRow, ReturnType<typeof classifySession>]> = [
    ['personal web chat', { channelType: 'web', visibility: 'owner', appOrigin: 'chat', channelId: 'c1' },
      { audience: 'personal', anchor: { kind: 'none', ref: null }, transport: 'web', lane: 'conversation', machine: null, surface: 'chat' }],
    ['doc dock', { channelType: 'web', visibility: 'owner', appOrigin: 'doc', channelId: 'c1' },
      { audience: 'personal', anchor: { kind: 'none', ref: null }, transport: 'web', lane: 'conversation', machine: null, surface: 'doc' }],
    ['workspace room', { channelType: 'web', visibility: 'workspace', appOrigin: 'chat', channelId: 'r1' },
      { audience: 'workspace', anchor: { kind: 'none', ref: null }, transport: 'web', lane: 'conversation', machine: null, surface: 'chat' }],
    ['feed draft', { channelType: 'web', visibility: 'workspace', mode: 'draft', channelId: 'draft:1' },
      { audience: 'workspace', anchor: { kind: 'feed_draft', ref: 'draft:1' }, transport: 'web', lane: 'conversation', machine: null, surface: null }],
    ['platform feed draft (owner visibility)', { channelType: 'web', visibility: 'owner', mode: 'draft', channelId: 'draft:2' },
      { audience: 'workspace', anchor: { kind: 'feed_draft', ref: 'draft:2' }, transport: 'web', lane: 'conversation', machine: null, surface: null }],
    ['doc comment thread', { channelType: 'doc_thread', visibility: 'workspace', channelId: 't1' },
      { audience: 'workspace', anchor: { kind: 'doc_thread', ref: 't1' }, transport: 'web', lane: 'conversation', machine: null, surface: null }],
    ['office file thread', { channelType: 'office_thread', visibility: 'workspace', channelId: 'o1' },
      { audience: 'workspace', anchor: { kind: 'office_file', ref: 'o1' }, transport: 'web', lane: 'conversation', machine: null, surface: null }],
    ['feed thread', { channelType: 'feed_thread', visibility: 'workspace', channelId: 'feed-thread:9' },
      { audience: 'workspace', anchor: { kind: 'feed_thread', ref: 'feed-thread:9' }, transport: 'web', lane: 'conversation', machine: null, surface: null }],
    ['external DM', { channelType: 'telegram', visibility: 'owner', channelId: '12345' },
      { audience: 'personal', anchor: { kind: 'none', ref: null }, transport: 'telegram', lane: 'conversation', machine: null, surface: null }],
    ['notification inbox', { channelType: 'notification', visibility: 'owner', channelId: 'notifications' },
      { audience: 'personal', anchor: { kind: 'inbox', ref: 'notifications' }, transport: 'web', lane: 'conversation', machine: null, surface: null }],
    ['inbox sentinel on an external channel', { channelType: 'telegram', visibility: 'owner', channelId: 'notifications' },
      { audience: 'personal', anchor: { kind: 'inbox', ref: null }, transport: 'telegram', lane: 'conversation', machine: null, surface: null }],
  ]
  for (const [name, row, expected] of shapes) {
    it(`classifies ${name}`, () => {
      expect(classifySession(row)).toEqual(expected)
    })
  }

  const machines: Array<[string, SessionKindRow, string]> = [
    ['A2A callee', { channelType: 'assistant-call', channelId: 'x' }, 'a2a'],
    ['workflow run', { channelType: 'workflow', channelId: 'run-1' }, 'workflow'],
    ['public API', { channelType: 'api', channelId: 'k' }, 'api'],
    ['brain inspection', { channelType: 'brain_inspection', channelId: 'i', transient: true }, 'inspection'],
    ['brain edit', { channelType: 'brain_edit', channelId: 'e', transient: true }, 'inspection'],
    ['legacy cron', { channelType: 'cron', channelId: 'j' }, 'cron'],
  ]
  for (const [name, row, machine] of machines) {
    it(`classifies ${name} as a machine lane`, () => {
      const kind = classifySession(row)
      expect(kind.lane).toBe('machine')
      expect(kind.machine).toBe(machine)
    })
  }

  it('anchors workflow and cron runs to a job', () => {
    expect(classifySession({ channelType: 'workflow', channelId: 'run-1' }).anchor).toEqual({ kind: 'job', ref: 'run-1' })
  })

  it('treats a transient row on an unknown channel as a machine lane', () => {
    expect(classifySession({ channelType: 'web', channelId: 'x', transient: true }).lane).toBe('machine')
  })

  it('recognizes the tuning sentinel', () => {
    expect(isTuningSession({ channelId: 'tuning' })).toBe(true)
    expect(isTuningSession({ channelId: 'abc' })).toBe(false)
  })
})
