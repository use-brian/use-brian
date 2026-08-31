import { describe, expect, it } from 'vitest'
import { evaluateCrmSendability } from '../sendability.js'

describe('[COMP:crm/sendability] evaluateCrmSendability', () => {
  const base = {
    channel: 'email' as const,
    hasContactMethod: true,
    purpose: { archived: false, requiresConsent: true },
    consentEvents: [{ id: 'consent-1', action: 'granted' as const, occurredAt: '2026-01-01T00:00:00Z' }],
    suppressionEvents: [],
  }

  it('allows only a present address, effective grant, and no suppression', () => {
    expect(evaluateCrmSendability(base)).toEqual({
      verdict: 'allowed',
      reasons: [],
      effectiveConsentEventId: 'consent-1',
      effectiveSuppressionEventIds: [],
    })
  })

  it('returns unknown rather than permission for missing evidence', () => {
    expect(evaluateCrmSendability({
      ...base,
      hasContactMethod: false,
      consentEvents: [],
    })).toEqual({
      verdict: 'unknown',
      reasons: ['contact_method_missing', 'consent_not_recorded'],
      effectiveSuppressionEventIds: [],
    })
  })

  it('blocks an effective global or channel suppression', () => {
    const verdict = evaluateCrmSendability({
      ...base,
      suppressionEvents: [
        { id: 'old-all', channel: 'all', action: 'released', occurredAt: '2026-01-01T00:00:00Z' },
        { id: 'new-all', channel: 'all', action: 'suppressed', occurredAt: '2026-02-01T00:00:00Z' },
        { id: 'email', channel: 'email', action: 'suppressed', occurredAt: '2026-03-01T00:00:00Z' },
      ],
    })
    expect(verdict.verdict).toBe('blocked')
    expect(verdict.reasons).toEqual(['global_suppression', 'channel_suppression'])
    expect(verdict.effectiveSuppressionEventIds).toEqual(['new-all', 'email'])
  })

  it('blocks withdrawal even if an older grant exists', () => {
    expect(evaluateCrmSendability({
      ...base,
      consentEvents: [
        ...base.consentEvents,
        { id: 'consent-2', action: 'withdrawn', occurredAt: '2026-02-01T00:00:00Z' },
      ],
    })).toMatchObject({ verdict: 'blocked', reasons: ['consent_withdrawn'], effectiveConsentEventId: 'consent-2' })
  })

  it('does not require consent for a purpose configured without it', () => {
    expect(evaluateCrmSendability({
      ...base,
      purpose: { archived: false, requiresConsent: false },
      consentEvents: [],
    }).verdict).toBe('allowed')
  })

  it('blocks archived purposes', () => {
    expect(evaluateCrmSendability({
      ...base,
      purpose: { archived: true, requiresConsent: true },
    })).toMatchObject({ verdict: 'blocked', reasons: ['purpose_archived'] })
  })
})
