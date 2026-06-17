import { describe, it, expect } from 'vitest'

import {
  MANUAL_PASTE_INLINE_MAX_BYTES,
  SOURCE_KINDS,
  episodeContentRefSchema,
  episodeEnvelopeSchema,
  sensitivitySchema,
  sourceKindSchema,
} from '../index.js'
import type {
  EpisodeContentRef,
  EpisodeEnvelope,
  SourceKind,
} from '../index.js'

const ENVELOPE_FIXTURE: EpisodeEnvelope = {
  source_kind: 'manual_paste',
  source_ref: { origin: 'test' },
  occurred_at: new Date('2026-05-14T10:00:00.000Z'),
  actors: [{ user_id: 'u-1', role: 'sender' }],
  content: {
    raw: 'hello world',
    attachments: [],
  },
  sensitivity: 'internal',
  user_id: 'u-1',
  assistant_id: null,
  workspace_id: 'ws-1',
  created_by_user_id: 'u-1',
  created_by_assistant_id: null,
}

describe('[COMP:brain/episode-envelope] Episode envelope contract', () => {
  describe('SourceKind vocabulary', () => {
    it('declares all 14 locked source kinds', () => {
      expect(SOURCE_KINDS).toHaveLength(14)
    })

    it('includes SV 2026-05-14 additions', () => {
      expect(SOURCE_KINDS).toEqual(
        expect.arrayContaining([
          'bulk_profile_import',
          'profile_materialization',
          'voice_memo',
          'platform_engagement_digest',
        ]),
      )
    })

    it('parses each kind via sourceKindSchema', () => {
      for (const kind of SOURCE_KINDS) {
        expect(sourceKindSchema.parse(kind)).toBe(kind)
      }
    })

    it('rejects an unknown kind', () => {
      expect(() => sourceKindSchema.parse('not_a_kind')).toThrow()
    })
  })

  describe('sensitivitySchema', () => {
    it('accepts the three tiers', () => {
      expect(sensitivitySchema.parse('public')).toBe('public')
      expect(sensitivitySchema.parse('internal')).toBe('internal')
      expect(sensitivitySchema.parse('confidential')).toBe('confidential')
    })

    it('rejects restricted', () => {
      // Episodes do not enforce a 'restricted' tier; aligns with
      // packages/core/src/security/sensitivity.ts.
      expect(() => sensitivitySchema.parse('restricted')).toThrow()
    })
  })

  describe('EpisodeContentRef discriminated union — round-trip each variant', () => {
    const variants: Array<{ name: SourceKind; fixture: EpisodeContentRef }> = [
      {
        name: 'web_chat',
        fixture: {
          source_kind: 'web_chat',
          session_id: 'sess-1',
          message_id_range: ['m-1', 'm-9'],
        },
      },
      {
        name: 'slack_thread',
        fixture: {
          source_kind: 'slack_thread',
          slack_workspace_id: 'T123',
          channel_id: 'C456',
          thread_ts: '1700000000.000100',
          message_count: 7,
        },
      },
      {
        name: 'email_thread',
        fixture: {
          source_kind: 'email_thread',
          message_id_chain: ['<a@example.com>', '<b@example.com>'],
        },
      },
      {
        name: 'meeting',
        fixture: {
          source_kind: 'meeting',
          transcript_file_id: 'wf-transcript-1',
          recording_url: 'https://example.com/rec.mp4',
          attendee_external_ids: ['ext-1', 'ext-2'],
        },
      },
      {
        name: 'github_sync',
        fixture: {
          source_kind: 'github_sync',
          repo: 'acme/widget',
          commit_from: 'aaa111',
          commit_to: 'bbb222',
          files_changed: ['src/index.ts', 'README.md'],
        },
      },
      {
        name: 'file_upload',
        fixture: {
          source_kind: 'file_upload',
          file_id: 'wf-1',
        },
      },
      {
        name: 'manual_paste',
        fixture: {
          source_kind: 'manual_paste',
          inline: 'a quick paste',
        },
      },
      {
        name: 'channel_window',
        fixture: {
          source_kind: 'channel_window',
          channel_id: 'C1',
          window_start: new Date('2026-05-14T09:00:00.000Z'),
          window_end: new Date('2026-05-14T10:00:00.000Z'),
          message_count: 4,
        },
      },
      {
        name: 'connector_action',
        fixture: {
          source_kind: 'connector_action',
          connector_id: 'gmail',
          action_kind: 'send_email',
          external_id: 'msg-abc',
        },
      },
      {
        name: 'inter_assistant_handoff',
        fixture: {
          source_kind: 'inter_assistant_handoff',
          from_assistant_id: 'a-1',
          to_assistant_id: 'a-2',
          context_summary: 'hand-off summary',
        },
      },
      {
        name: 'bulk_profile_import',
        fixture: {
          source_kind: 'bulk_profile_import',
          provider: 'linkedin',
          profile_count: 250,
          manifest_file_id: 'wf-manifest-1',
        },
      },
      {
        name: 'profile_materialization',
        fixture: {
          source_kind: 'profile_materialization',
          bulk_episode_id: 'ep-bulk-1',
          entity_id: 'ent-1',
          trigger_kind: 'meeting',
        },
      },
      {
        name: 'voice_memo',
        fixture: {
          source_kind: 'voice_memo',
          audio_file_id: 'wf-audio-1',
          duration_secs: 42,
          transcribed_at: new Date('2026-05-14T10:01:00.000Z'),
          transcript_file_id: 'wf-transcript-2',
          sub_kind: 'note',
        },
      },
      {
        name: 'platform_engagement_digest',
        fixture: {
          source_kind: 'platform_engagement_digest',
          platform: 'threads',
          period_start: new Date('2026-05-13T00:00:00.000Z'),
          period_end: new Date('2026-05-14T00:00:00.000Z'),
          metrics: {
            per_post: [
              {
                post_episode_id: 'ep-post-1',
                likes: 12,
                replies: 3,
                views: 800,
                reposts: 1,
                follower_delta_attributed: 4,
              },
            ],
            aggregate: {
              total_engagement: 16,
              follower_delta: 7,
              top_post_episode_id: 'ep-post-1',
            },
          },
        },
      },
    ]

    it('covers all 14 source kinds', () => {
      expect(variants.map((v) => v.name)).toEqual(Array.from(SOURCE_KINDS))
    })

    for (const { name, fixture } of variants) {
      it(`round-trips ${name}`, () => {
        expect(episodeContentRefSchema.parse(fixture)).toEqual(fixture)
      })
    }
  })

  describe('EpisodeContentRef rejection cases', () => {
    it('rejects a missing discriminator', () => {
      expect(() => episodeContentRefSchema.parse({ session_id: 's-1' })).toThrow()
    })

    it('rejects an unknown source_kind', () => {
      expect(() =>
        episodeContentRefSchema.parse({
          source_kind: 'bogus',
          inline: 'x',
        }),
      ).toThrow()
    })

    it('rejects a variant missing required fields', () => {
      expect(() =>
        episodeContentRefSchema.parse({
          source_kind: 'slack_thread',
          slack_workspace_id: 'T1',
          channel_id: 'C1',
          // thread_ts + message_count missing
        }),
      ).toThrow()
    })
  })

  describe('manual_paste 16KB cap (data-model.md:421)', () => {
    it('accepts exactly 16384 bytes', () => {
      const inline = 'a'.repeat(MANUAL_PASTE_INLINE_MAX_BYTES)
      expect(
        episodeContentRefSchema.parse({ source_kind: 'manual_paste', inline }),
      ).toEqual({ source_kind: 'manual_paste', inline })
    })

    it('rejects one byte over the cap', () => {
      const inline = 'a'.repeat(MANUAL_PASTE_INLINE_MAX_BYTES + 1)
      expect(() =>
        episodeContentRefSchema.parse({ source_kind: 'manual_paste', inline }),
      ).toThrow(/exceeds/)
    })

    it('counts UTF-8 bytes, not code units', () => {
      // '🦄' is 4 UTF-8 bytes per char. 4096 chars × 4 bytes = 16384 — OK.
      const ok = '🦄'.repeat(MANUAL_PASTE_INLINE_MAX_BYTES / 4)
      expect(() =>
        episodeContentRefSchema.parse({ source_kind: 'manual_paste', inline: ok }),
      ).not.toThrow()
      // One more unicorn pushes it over.
      const over = ok + '🦄'
      expect(() =>
        episodeContentRefSchema.parse({ source_kind: 'manual_paste', inline: over }),
      ).toThrow(/exceeds/)
    })
  })

  describe('date coercion', () => {
    it('coerces ISO strings to Date on channel_window', () => {
      const parsed = episodeContentRefSchema.parse({
        source_kind: 'channel_window',
        channel_id: 'C1',
        window_start: '2026-05-14T09:00:00.000Z',
        window_end: '2026-05-14T10:00:00.000Z',
        message_count: 4,
      })
      if (parsed.source_kind !== 'channel_window') throw new Error('discriminator')
      expect(parsed.window_start).toBeInstanceOf(Date)
      expect(parsed.window_end).toBeInstanceOf(Date)
      expect(parsed.window_start.toISOString()).toBe('2026-05-14T09:00:00.000Z')
    })

    it('coerces ISO strings to Date on voice_memo.transcribed_at', () => {
      const parsed = episodeContentRefSchema.parse({
        source_kind: 'voice_memo',
        audio_file_id: 'wf-1',
        duration_secs: 10,
        transcribed_at: '2026-05-14T10:01:00.000Z',
        sub_kind: 'thought',
      })
      if (parsed.source_kind !== 'voice_memo') throw new Error('discriminator')
      expect(parsed.transcribed_at).toBeInstanceOf(Date)
    })

    it('coerces ISO strings to Date on platform_engagement_digest', () => {
      const parsed = episodeContentRefSchema.parse({
        source_kind: 'platform_engagement_digest',
        platform: 'twitter',
        period_start: '2026-05-13T00:00:00.000Z',
        period_end: '2026-05-14T00:00:00.000Z',
        metrics: { per_post: [], aggregate: {} },
      })
      if (parsed.source_kind !== 'platform_engagement_digest') throw new Error('discriminator')
      expect(parsed.period_start).toBeInstanceOf(Date)
      expect(parsed.period_end).toBeInstanceOf(Date)
    })
  })

  describe('EpisodeEnvelope', () => {
    it('round-trips a valid envelope', () => {
      const parsed = episodeEnvelopeSchema.parse(ENVELOPE_FIXTURE)
      expect(parsed).toEqual(ENVELOPE_FIXTURE)
    })

    it('coerces ISO occurred_at to Date', () => {
      const parsed = episodeEnvelopeSchema.parse({
        ...ENVELOPE_FIXTURE,
        occurred_at: '2026-05-14T10:00:00.000Z',
      })
      expect(parsed.occurred_at).toBeInstanceOf(Date)
    })

    it('rejects when both user_id and assistant_id are null (data-model.md:282)', () => {
      expect(() =>
        episodeEnvelopeSchema.parse({
          ...ENVELOPE_FIXTURE,
          user_id: null,
          assistant_id: null,
        }),
      ).toThrow(/visibility/)
    })

    it('accepts assistant_id-only visibility', () => {
      expect(() =>
        episodeEnvelopeSchema.parse({
          ...ENVELOPE_FIXTURE,
          user_id: null,
          assistant_id: 'a-1',
        }),
      ).not.toThrow()
    })

    it('rejects an unknown sensitivity tier', () => {
      expect(() =>
        episodeEnvelopeSchema.parse({
          ...ENVELOPE_FIXTURE,
          sensitivity: 'restricted',
        }),
      ).toThrow()
    })
  })

  describe('type-level discriminator narrowing (compile-time)', () => {
    it('lets `satisfies` enforce variant shapes', () => {
      // These `satisfies` assertions would fail typecheck if a variant
      // tag was dropped or a required field was renamed. The test body
      // is a tautology — its value is in the type checker.
      const _webChat = {
        source_kind: 'web_chat',
        session_id: 's',
        message_id_range: ['a', 'b'],
      } satisfies EpisodeContentRef
      const _voiceMemo = {
        source_kind: 'voice_memo',
        audio_file_id: 'f',
        duration_secs: 1,
        sub_kind: 'note',
      } satisfies EpisodeContentRef
      const _platform = {
        source_kind: 'platform_engagement_digest',
        platform: 'threads',
        period_start: new Date(),
        period_end: new Date(),
        metrics: { per_post: [], aggregate: {} },
      } satisfies EpisodeContentRef
      expect(_webChat.source_kind).toBe('web_chat')
      expect(_voiceMemo.source_kind).toBe('voice_memo')
      expect(_platform.source_kind).toBe('platform_engagement_digest')
    })
  })
})
