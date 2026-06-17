import { describe, it, expect } from 'vitest'
import {
  classifyReaction,
  normalizeReactionKey,
  reactionDetailsLabel,
} from '../emoji-reactions.js'

describe('[COMP:shared/emoji-reactions] Reaction classifier', () => {
  describe('normalizeReactionKey', () => {
    it('strips Slack colons and lowercases', () => {
      expect(normalizeReactionKey(':ThumbsUp:')).toBe('thumbsup')
    })

    it('strips Slack skin-tone modifiers', () => {
      expect(normalizeReactionKey('+1::skin-tone-3')).toBe('+1')
      expect(normalizeReactionKey(':thumbsup::skin-tone-5:')).toBe('thumbsup')
    })

    it('strips unicode skin-tone modifiers', () => {
      // U+1F3FB-U+1F3FF — Fitzpatrick skin tones
      expect(normalizeReactionKey('👍🏽')).toBe('👍')
      expect(normalizeReactionKey('👏🏿')).toBe('👏')
    })

    it('strips the variation selector', () => {
      // U+FE0F often emitted on heart
      expect(normalizeReactionKey('❤️')).toBe('❤')
    })

    it('returns empty string for whitespace', () => {
      expect(normalizeReactionKey('   ')).toBe('')
      expect(normalizeReactionKey('')).toBe('')
    })
  })

  describe('classifyReaction — positive', () => {
    it.each([
      ['thumbsup', 'thumbsup'],
      ['+1', 'thumbsup'],
      ['👍', 'thumbsup'],
      ['clap', 'applause'],
      ['👏', 'applause'],
      ['raised_hands', 'applause'],
      ['🙌', 'applause'],
      ['tada', 'celebration'],
      ['🎉', 'celebration'],
      ['white_check_mark', 'affirmation'],
      ['✅', 'affirmation'],
      ['100', 'excellent'],
      ['💯', 'excellent'],
      ['fire', 'excellent'],
      ['🔥', 'excellent'],
      ['heart', 'love'],
      ['heart_eyes', 'love'],
      ['😍', 'love'],
      ['muscle', 'strong'],
      ['💪', 'strong'],
      ['star', 'excellent'],
      ['⭐', 'excellent'],
      ['sparkles', 'excellent'],
      ['✨', 'excellent'],
    ])('classifies %s as positive (%s)', (raw, issueType) => {
      const result = classifyReaction(raw)
      expect(result).toEqual({ kind: 'positive', issueType })
    })

    it('handles skin-tone modifiers on positive emoji', () => {
      expect(classifyReaction('👍🏽')).toEqual({ kind: 'positive', issueType: 'thumbsup' })
      expect(classifyReaction(':+1::skin-tone-4:')).toEqual({ kind: 'positive', issueType: 'thumbsup' })
    })

    it('handles Slack-style colons on positive emoji', () => {
      expect(classifyReaction(':fire:')).toEqual({ kind: 'positive', issueType: 'excellent' })
    })
  })

  describe('classifyReaction — negative', () => {
    it.each([
      ['thumbsdown', 'thumbsdown'],
      ['-1', 'thumbsdown'],
      ['👎', 'thumbsdown'],
      ['x', 'incorrect'],
      ['❌', 'incorrect'],
      ['no_entry_sign', 'inappropriate'],
      ['🚫', 'inappropriate'],
      ['angry', 'frustration'],
      ['😠', 'frustration'],
      ['rage', 'frustration'],
      ['😡', 'frustration'],
      ['thinking', 'unclear'],
      ['🤔', 'unclear'],
      ['confused', 'unclear'],
      ['😕', 'unclear'],
      ['disappointed', 'disappointed'],
      ['😞', 'disappointed'],
      ['cry', 'disappointed'],
      ['😢', 'disappointed'],
      ['sob', 'disappointed'],
      ['rolling_eyes', 'dismissive'],
      ['🙄', 'dismissive'],
      ['nauseated_face', 'strong_disgust'],
      ['🤢', 'strong_disgust'],
      ['vomiting_face', 'strong_disgust'],
      ['🤮', 'strong_disgust'],
      ['sleeping', 'boring'],
      ['😴', 'boring'],
    ])('classifies %s as negative (%s)', (raw, issueType) => {
      const result = classifyReaction(raw)
      expect(result).toEqual({ kind: 'negative', issueType })
    })

    it('handles skin-tone modifiers on negative emoji', () => {
      expect(classifyReaction('👎🏾')).toEqual({ kind: 'negative', issueType: 'thumbsdown' })
    })
  })

  describe('classifyReaction — ambiguous (returns null)', () => {
    it.each([
      'eyes',         // "I'll look at this later" — not negative
      '👀',
      'pray',         // could be thanks OR high-five
      '🙏',
      'shrug',        // ambiguous
      '🤷',
      'see_no_evil',  // playful — not real negativity
      '🙈',
      'wave',         // greeting
      '👋',
      'point_up',     // emphasis, not feedback
      '☝',
      'speech_balloon',
      '💬',
    ])('returns null for ambiguous %s', (raw) => {
      expect(classifyReaction(raw)).toBeNull()
    })

    it('returns null for unknown emoji', () => {
      expect(classifyReaction('🦄')).toBeNull()
      expect(classifyReaction('some_random_custom_emoji')).toBeNull()
    })

    it('returns null for empty / whitespace input', () => {
      expect(classifyReaction('')).toBeNull()
      expect(classifyReaction('   ')).toBeNull()
    })
  })

  describe('reactionDetailsLabel', () => {
    it('wraps the normalised key in colons', () => {
      expect(reactionDetailsLabel('👍')).toBe(':👍:')
      expect(reactionDetailsLabel(':thumbsdown:')).toBe(':thumbsdown:')
      expect(reactionDetailsLabel('+1::skin-tone-3')).toBe(':+1:')
    })
  })
})
