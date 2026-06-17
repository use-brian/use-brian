import { describe, it, expect } from 'vitest'

import {
  DEFAULT_INGEST_RULES,
  getDefaultRules,
  type IngestSourceProvider,
} from '../default-rules.js'

const SOURCES: readonly IngestSourceProvider[] = [
  'slack',
  'github',
  'calendar',
  'fathom',
]

const UNIVERSAL_FILTERS = [
  'always',
  'keyword_match',
  'actor_match',
  'sender_match',
  'mention_of',
  'user_flag',
] as const

const SOURCE_SPECIFIC_FILTERS: Record<IngestSourceProvider, readonly string[]> = {
  slack: ['channel_match', 'is_dm', 'is_mention', 'user_match'],
  github: ['event_type', 'repo_match', 'actor_match', 'branch_match'],
  calendar: ['attendee_match', 'organizer_match', 'subject_contains', 'is_recurring'],
  fathom: ['meeting_subject_contains', 'attendee_match'],
}

const VALID_TEMPLATE_KEYS = [
  'filter_type',
  'filter_params',
  'routing_mode',
  'routing_schedule',
  'alert',
]

describe('[COMP:brain/default-rules] Default ingest rule templates', () => {
  describe('coverage', () => {
    it('declares default rules for every launch source', () => {
      for (const source of SOURCES) {
        expect(DEFAULT_INGEST_RULES[source].length).toBeGreaterThan(0)
      }
    })

    it('exposes the same lists via getDefaultRules', () => {
      for (const source of SOURCES) {
        expect(getDefaultRules(source)).toBe(DEFAULT_INGEST_RULES[source])
      }
    })
  })

  describe('spec snapshot — ingest.md §Default rule templates per source', () => {
    it('Slack', () => {
      // Realtime entries use the slack-adapter filter set (is_mention /
      // user_match scan the SlackThreadInput directly). They are best-
      // effort until Slack-flavored placeholder resolution lands; the
      // `always → scheduled` catchall is the load-bearing rule today —
      // it routes every channel message into a daily digest Episode and
      // Pipeline B's LLM extraction filters signal vs noise.
      expect(DEFAULT_INGEST_RULES.slack).toEqual([
        {
          filter_type: 'is_mention',
          filter_params: { values: [':workspace_members'] },
          routing_mode: 'realtime',
        },
        { filter_type: 'is_dm', filter_params: {}, routing_mode: 'realtime' },
        {
          filter_type: 'user_match',
          filter_params: { values: [':crm_contacts'] },
          routing_mode: 'realtime',
        },
        {
          filter_type: 'always',
          filter_params: {},
          routing_mode: 'scheduled',
          routing_schedule: '0 9 * * 1-5',
        },
      ])
    })

    it('GitHub', () => {
      expect(DEFAULT_INGEST_RULES.github).toEqual([
        {
          filter_type: 'event_type',
          filter_params: { values: ['pull_request.merged', 'security_alert', 'release'] },
          routing_mode: 'realtime',
          alert: true,
        },
        {
          filter_type: 'event_type',
          filter_params: { values: ['pull_request.opened', 'issue.opened'] },
          routing_mode: 'realtime',
        },
        {
          filter_type: 'branch_match',
          filter_params: { values: ['main'] },
          routing_mode: 'realtime',
        },
        {
          filter_type: 'actor_match',
          filter_params: { values: ['dependabot[bot]', 'renovate[bot]'] },
          routing_mode: 'drop',
        },
        {
          filter_type: 'always',
          filter_params: {},
          routing_mode: 'scheduled',
          routing_schedule: '0 18 * * 1-5',
        },
      ])
    })

    it('Calendar', () => {
      expect(DEFAULT_INGEST_RULES.calendar).toEqual([
        {
          filter_type: 'attendee_match',
          filter_params: { values: [':workspace_members'] },
          routing_mode: 'realtime',
        },
        {
          filter_type: 'attendee_match',
          filter_params: { values: [':crm_contacts'] },
          routing_mode: 'realtime',
        },
        { filter_type: 'is_recurring', filter_params: {}, routing_mode: 'drop' },
        {
          filter_type: 'always',
          filter_params: {},
          routing_mode: 'scheduled',
          routing_schedule: '0 8 * * *',
        },
      ])
    })

    it('Fathom', () => {
      expect(DEFAULT_INGEST_RULES.fathom).toEqual([
        { filter_type: 'always', filter_params: {}, routing_mode: 'realtime' },
      ])
    })
  })

  describe('migration-130 schema invariants', () => {
    it('routing_schedule is set iff routing_mode is scheduled', () => {
      for (const source of SOURCES) {
        for (const rule of DEFAULT_INGEST_RULES[source]) {
          if (rule.routing_mode === 'scheduled') {
            expect(typeof rule.routing_schedule).toBe('string')
            expect(rule.routing_schedule).not.toBe('')
          } else {
            expect(rule.routing_schedule).toBeUndefined()
          }
        }
      }
    })

    it('routing_mode is one of realtime|scheduled|drop', () => {
      const allowed = ['realtime', 'scheduled', 'drop']
      for (const source of SOURCES) {
        for (const rule of DEFAULT_INGEST_RULES[source]) {
          expect(allowed).toContain(rule.routing_mode)
        }
      }
    })

    it('alert is only present when true (omit-when-false convention)', () => {
      for (const source of SOURCES) {
        for (const rule of DEFAULT_INGEST_RULES[source]) {
          if ('alert' in rule) {
            expect(rule.alert).toBe(true)
          }
        }
      }
    })
  })

  describe('filter vocabulary — ingest.md §Filter library', () => {
    for (const source of SOURCES) {
      it(`${source} uses only filters in its allowlist`, () => {
        const allowed = [...UNIVERSAL_FILTERS, ...SOURCE_SPECIFIC_FILTERS[source]]
        for (const rule of DEFAULT_INGEST_RULES[source]) {
          expect(allowed).toContain(rule.filter_type)
        }
      })
    }
  })

  describe('template shape', () => {
    it('no template carries fields beyond the contract', () => {
      for (const source of SOURCES) {
        for (const rule of DEFAULT_INGEST_RULES[source]) {
          for (const key of Object.keys(rule)) {
            expect(VALID_TEMPLATE_KEYS).toContain(key)
          }
        }
      }
    })
  })
})
