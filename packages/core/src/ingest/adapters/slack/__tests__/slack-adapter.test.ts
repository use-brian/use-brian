import { describe, it, expect } from 'vitest'
import {
  channelMatch,
  isDm,
  isMention,
  userMatch,
  slackFilterImplementations,
  slackFilterParamsSchemas,
  slackDefaultRules,
  slackAdapter,
} from '../index.js'
import type { SlackThreadInput } from '../index.js'

function thread(over: Partial<SlackThreadInput> = {}): SlackThreadInput {
  return {
    team_id: 'T1',
    channel_id: 'C100',
    thread_ts: '1700000000.000100',
    messages: [{ ts: '1700000000.000100', user: 'U1', text: 'hello' }],
    ...over,
  }
}

describe('[COMP:brain/source-adapters/slack] Slack adapter — filters', () => {
  describe('channel_match', () => {
    it('matches when the channel id is in values', () => {
      expect(channelMatch(thread({ channel_id: 'C100' }), { values: ['C100', 'C200'] })).toBe(true)
    })
    it('does not match a different channel', () => {
      expect(channelMatch(thread({ channel_id: 'C999' }), { values: ['C100'] })).toBe(false)
    })
  })

  describe('is_dm', () => {
    it('is true for a DM channel (D-prefixed id)', () => {
      expect(isDm(thread({ channel_id: 'D42' }), {})).toBe(true)
    })
    it('is false for a regular channel', () => {
      expect(isDm(thread({ channel_id: 'C42' }), {})).toBe(false)
    })
  })

  describe('is_mention', () => {
    it('is true when a message @-mentions a target user', () => {
      const t = thread({ messages: [{ ts: '1', user: 'U1', text: 'hey <@U9> look' }] })
      expect(isMention(t, { values: ['U9'] })).toBe(true)
    })
    it('is false when no message mentions a target user', () => {
      const t = thread({ messages: [{ ts: '1', user: 'U1', text: 'no mentions here' }] })
      expect(isMention(t, { values: ['U9'] })).toBe(false)
    })
    it('ignores a bare username outside the <@id> mention form', () => {
      const t = thread({ messages: [{ ts: '1', user: 'U1', text: 'U9 is great' }] })
      expect(isMention(t, { values: ['U9'] })).toBe(false)
    })
  })

  describe('user_match', () => {
    it('is true when a message author is in values', () => {
      const t = thread({ messages: [{ ts: '1', user: 'U7', text: 'hi' }] })
      expect(userMatch(t, { values: ['U7'] })).toBe(true)
    })
    it('is false when no author matches', () => {
      expect(userMatch(thread(), { values: ['U7'] })).toBe(false)
    })
    it('skips bot-only messages with no user field', () => {
      const t = thread({ messages: [{ ts: '1', bot_id: 'B1', text: 'beep' }] })
      expect(userMatch(t, { values: ['U7'] })).toBe(false)
    })
  })
})

describe('[COMP:brain/source-adapters/slack] Slack adapter — registry + rules', () => {
  it('registers all four filter types', () => {
    expect(Object.keys(slackFilterImplementations).sort()).toEqual([
      'channel_match', 'is_dm', 'is_mention', 'user_match',
    ])
  })

  it('exposes a param schema per filter type', () => {
    expect(Object.keys(slackFilterParamsSchemas).sort()).toEqual([
      'channel_match', 'is_dm', 'is_mention', 'user_match',
    ])
  })

  it('is_dm schema is strict — rejects unexpected params', () => {
    expect(slackFilterParamsSchemas.is_dm.safeParse({}).success).toBe(true)
    expect(slackFilterParamsSchemas.is_dm.safeParse({ values: ['x'] }).success).toBe(false)
  })

  it('channel_match schema requires a non-empty values array', () => {
    expect(slackFilterParamsSchemas.channel_match.safeParse({ values: ['C1'] }).success).toBe(true)
    expect(slackFilterParamsSchemas.channel_match.safeParse({ values: [] }).success).toBe(false)
  })

  it('seeds default rules ending in a catch-all scheduled digest', () => {
    expect(slackDefaultRules.length).toBeGreaterThan(0)
    const last = slackDefaultRules[slackDefaultRules.length - 1]
    expect(last.filter_type).toBe('always')
    expect(last.routing_mode).toBe('scheduled')
    expect(last.routing_schedule).toBeTruthy()
  })

  it('every default rule references a known filter type or `always`', () => {
    const known = new Set<string>([...Object.keys(slackFilterImplementations), 'always'])
    for (const rule of slackDefaultRules) {
      expect(known.has(rule.filter_type)).toBe(true)
    }
  })
})

describe('[COMP:brain/source-adapters/slack] Slack adapter — object shape', () => {
  it('exposes the canonical adapter surface', () => {
    expect(slackAdapter.source).toBe('slack')
    expect(typeof slackAdapter.normalize).toBe('function')
    expect(slackAdapter.filterImplementations).toBe(slackFilterImplementations)
    expect(slackAdapter.filterParamsSchemas).toBe(slackFilterParamsSchemas)
    expect(slackAdapter.defaultRules).toBe(slackDefaultRules)
  })
})
