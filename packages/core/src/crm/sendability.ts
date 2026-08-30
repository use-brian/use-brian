/**
 * Canonical consent/suppression evaluator. Unknown is intentionally distinct
 * from allowed so every outbound consumer fails closed.
 *
 * [COMP:crm/sendability]
 */

import { z } from 'zod'

export const CrmDeliveryChannelSchema = z.enum([
  'email', 'sms', 'phone', 'whatsapp', 'telegram', 'slack',
])
export type CrmDeliveryChannel = z.infer<typeof CrmDeliveryChannelSchema>

export const SendabilityReasonSchema = z.enum([
  'contact_method_missing',
  'global_suppression',
  'channel_suppression',
  'consent_withdrawn',
  'consent_not_recorded',
  'purpose_archived',
])
export type SendabilityReason = z.infer<typeof SendabilityReasonSchema>

export type SendabilityVerdict = {
  verdict: 'allowed' | 'blocked' | 'unknown'
  reasons: SendabilityReason[]
  effectiveConsentEventId?: string
  effectiveSuppressionEventIds: string[]
}

export type ConsentEvidence = {
  id: string
  action: 'granted' | 'withdrawn'
  occurredAt: string | Date
  createdAt?: string | Date
}

export type SuppressionEvidence = {
  id: string
  channel: 'all' | CrmDeliveryChannel
  action: 'suppressed' | 'released'
  occurredAt: string | Date
  createdAt?: string | Date
}

export type SendabilityInput = {
  channel: CrmDeliveryChannel
  hasContactMethod: boolean
  purpose: {
    archived: boolean
    requiresConsent: boolean
  }
  consentEvents: readonly ConsentEvidence[]
  suppressionEvents: readonly SuppressionEvidence[]
}

function eventTime(event: { occurredAt: string | Date; createdAt?: string | Date }): number {
  const occurred = new Date(event.occurredAt).getTime()
  const created = event.createdAt ? new Date(event.createdAt).getTime() : occurred
  return Math.max(occurred, created)
}

function latest<T extends { id: string; occurredAt: string | Date; createdAt?: string | Date }>(
  events: readonly T[],
): T | undefined {
  return [...events].sort((left, right) => {
    const time = eventTime(right) - eventTime(left)
    return time !== 0 ? time : right.id.localeCompare(left.id)
  })[0]
}

export function evaluateCrmSendability(input: SendabilityInput): SendabilityVerdict {
  const reasons: SendabilityReason[] = []
  const global = latest(input.suppressionEvents.filter((event) => event.channel === 'all'))
  const channel = latest(input.suppressionEvents.filter((event) => event.channel === input.channel))
  const effectiveSuppressions: string[] = []

  if (global?.action === 'suppressed') {
    reasons.push('global_suppression')
    effectiveSuppressions.push(global.id)
  }
  if (channel?.action === 'suppressed') {
    reasons.push('channel_suppression')
    effectiveSuppressions.push(channel.id)
  }
  if (input.purpose.archived) reasons.push('purpose_archived')
  if (!input.hasContactMethod) reasons.push('contact_method_missing')

  const consent = latest(input.consentEvents)
  if (input.purpose.requiresConsent) {
    if (!consent) reasons.push('consent_not_recorded')
    else if (consent.action === 'withdrawn') reasons.push('consent_withdrawn')
  }

  const blocked = reasons.some((reason) =>
    reason === 'global_suppression'
      || reason === 'channel_suppression'
      || reason === 'consent_withdrawn'
      || reason === 'purpose_archived')
  const unknown = reasons.some((reason) =>
    reason === 'contact_method_missing' || reason === 'consent_not_recorded')

  return {
    verdict: blocked ? 'blocked' : unknown ? 'unknown' : 'allowed',
    reasons,
    ...(consent ? { effectiveConsentEventId: consent.id } : {}),
    effectiveSuppressionEventIds: effectiveSuppressions,
  }
}
