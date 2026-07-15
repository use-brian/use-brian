/**
 * Email-specific ingest filters, composed with `universalFilters` by the
 * webhook producer. The universal set already covers `sender_match` (the
 * event's `normalized.sender` is the bare lowercase address, so
 * `:workspace_members` / `:crm_contacts` placeholders resolve correctly) and
 * `keyword_match` over the body; these add the email-only axes:
 *
 *   - `gate_match`   — the webhook sender-gate verdict (`allowlisted` /
 *                      `stranger` / `noreply` / `at_cap` / `rate_capped`).
 *                      The seeded default routes `allowlisted` realtime.
 *   - `subject_match`— keyword match over the subject line only.
 *   - `domain_match` — sender domain (e.g. `acme.com`) for whole-org rules.
 *
 * [COMP:brain/source-adapters/email]
 */

import type { FilterRegistry, IngestEvent } from '../../filters.js'

function stringList(params: Record<string, unknown>, key: string): string[] {
  const raw = params[key]
  if (!Array.isArray(raw)) return []
  return raw.filter((v): v is string => typeof v === 'string')
}

function normalizedString(event: IngestEvent, key: string): string | null {
  const v = event.normalized[key]
  return typeof v === 'string' ? v : null
}

export const emailFilterImplementations: FilterRegistry = Object.freeze({
  gate_match: (event, params) => {
    const values = stringList(params, 'values')
    if (values.length === 0) return false
    const gate = normalizedString(event, 'gate')
    return gate !== null && values.includes(gate)
  },
  subject_match: (event, params) => {
    const keywords = [...stringList(params, 'keywords'), ...stringList(params, 'values')]
    if (keywords.length === 0) return false
    const subject = normalizedString(event, 'subject')
    if (subject === null) return false
    const haystack = subject.toLowerCase()
    return keywords.some((k) => k.length > 0 && haystack.includes(k.toLowerCase()))
  },
  domain_match: (event, params) => {
    const values = stringList(params, 'values')
    if (values.length === 0) return false
    const sender = normalizedString(event, 'sender')
    const domain = sender?.split('@')[1]
    if (!domain) return false
    return values.some((v) => v.toLowerCase().replace(/^@/, '') === domain)
  },
})
