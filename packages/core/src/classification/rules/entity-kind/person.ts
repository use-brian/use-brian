/**
 * Person classifier rules.
 *
 * Spec: docs/architecture/brain/classification/entity-kind.md §Person
 */

import type { EntityKind } from '../../../entities/types.js'
import type {
  ClassifierMatch,
  ClassifierNegativeRule,
  ClassifierRule,
} from '../../types.js'
import {
  candidateString,
  emailDomain,
  emailLocal,
  HONORIFIC_RE,
  isEmailShape,
  LINKEDIN_PROFILE_RE,
  NAME_TWO_WORDS_RE,
  PERSONAL_EMAIL_DOMAINS,
  SYSTEM_MAILBOX_LOCAL_PARTS,
} from './shared.js'

const ALL_BOUNDARIES = ['connector', 'tool', 'inbox', 'extraction', 'self_heal'] as const

// ── Positive rules ───────────────────────────────────────────────────

export const personEmailPersonalDomain: ClassifierRule<EntityKind> = {
  id: 'person-email-personal-domain',
  produces: 'person',
  tier: 'deterministic',  // PR 5 — flipped from probabilistic; an email with
                          // a personal-domain (gmail.com, etc.) is unambiguously
                          // a person, never a company or repo.
  confidence: 1.0,
  boundaries: ALL_BOUNDARIES,
  applies(c) {
    const s = candidateString(c)
    if (!isEmailShape(s)) return false
    return PERSONAL_EMAIL_DOMAINS.has(emailDomain(s))
  },
  evaluate(c) {
    const s = candidateString(c)
    if (!isEmailShape(s)) return null
    const local = emailLocal(s)
    if (SYSTEM_MAILBOX_LOCAL_PARTS.has(local)) return null
    return {
      rule_id: 'person-email-personal-domain',
      value: 'person',
      confidence: 1.0,
      tier: 'deterministic',
      derived: {
        attributes: { email: s, email_domain: emailDomain(s) },
      },
    } satisfies ClassifierMatch<EntityKind>
  },
}

export const personEmailCorporateDomain: ClassifierRule<EntityKind> = {
  id: 'person-email-corporate-domain',
  produces: 'person',
  tier: 'probabilistic',
  confidence: 0.9,
  boundaries: ALL_BOUNDARIES,
  applies(c) {
    const s = candidateString(c)
    if (!isEmailShape(s)) return false
    if (PERSONAL_EMAIL_DOMAINS.has(emailDomain(s))) return false
    return !SYSTEM_MAILBOX_LOCAL_PARTS.has(emailLocal(s))
  },
  evaluate(c) {
    const s = candidateString(c)
    if (!isEmailShape(s)) return null
    const domain = emailDomain(s)
    if (PERSONAL_EMAIL_DOMAINS.has(domain)) return null

    return {
      rule_id: 'person-email-corporate-domain',
      value: 'person',
      confidence: 0.9,
      tier: 'probabilistic',
      derived: {
        attributes: { email: s, email_domain: domain },
        // Composition — derive the company entity from the corporate domain
        // and a works_at edge from person → company. Composition executor
        // dedups by canonical_id so this is idempotent.
        entities: [
          {
            ref: 'employer',
            kind: 'company',
            display_name: domain,
            canonical_id: domain,
            attributes: { domain },
          },
        ],
        edges: [
          {
            source_ref: 'primary',
            target_ref: 'employer',
            edge_type: 'works_at',
          },
        ],
      },
    } satisfies ClassifierMatch<EntityKind>
  },
}

export const personLinkedinProfile: ClassifierRule<EntityKind> = {
  id: 'person-linkedin-profile-url',
  produces: 'person',
  tier: 'probabilistic',
  confidence: 0.95,
  boundaries: ALL_BOUNDARIES,
  applies(c) {
    return LINKEDIN_PROFILE_RE.test(candidateString(c))
  },
  evaluate(c) {
    const s = candidateString(c)
    if (!LINKEDIN_PROFILE_RE.test(s)) return null
    return {
      rule_id: 'person-linkedin-profile-url',
      value: 'person',
      confidence: 0.95,
      tier: 'probabilistic',
      derived: { attributes: { linkedin_url: s } },
    } satisfies ClassifierMatch<EntityKind>
  },
}

export const personHonorific: ClassifierRule<EntityKind> = {
  id: 'person-honorific-title',
  produces: 'person',
  tier: 'probabilistic',
  confidence: 0.85,
  boundaries: ALL_BOUNDARIES,
  applies(c) {
    return HONORIFIC_RE.test(c.primary)
  },
  evaluate(c) {
    if (!HONORIFIC_RE.test(c.primary)) return null
    return {
      rule_id: 'person-honorific-title',
      value: 'person',
      confidence: 0.85,
      tier: 'probabilistic',
    } satisfies ClassifierMatch<EntityKind>
  },
}

export const personTwoNameWords: ClassifierRule<EntityKind> = {
  id: 'person-two-name-words',
  produces: 'person',
  tier: 'probabilistic',
  confidence: 0.55,
  boundaries: ALL_BOUNDARIES,
  specificity: 0,  // weak — let stronger rules win on tie
  applies(c) {
    if (c.canonical_id) return false  // canonical_id present → other rules will fire
    return NAME_TWO_WORDS_RE.test(c.primary.trim())
  },
  evaluate(c) {
    if (c.canonical_id) return null
    if (!NAME_TWO_WORDS_RE.test(c.primary.trim())) return null
    return {
      rule_id: 'person-two-name-words',
      value: 'person',
      confidence: 0.55,
      tier: 'probabilistic',
    } satisfies ClassifierMatch<EntityKind>
  },
}

// ── Negative rules ───────────────────────────────────────────────────

export const notPersonSystemMailbox: ClassifierNegativeRule<EntityKind> = {
  id: 'not-person-system-mailbox',
  blocks: ['person'],
  tier: 'deterministic',
  boundaries: ALL_BOUNDARIES,
  applies(c) {
    const s = candidateString(c)
    if (!isEmailShape(s)) return false
    return SYSTEM_MAILBOX_LOCAL_PARTS.has(emailLocal(s))
  },
  reason: 'system mailbox (no-reply, support, notifications, etc.) — not a person',
}

// ── Bundle ───────────────────────────────────────────────────────────

export const personRules = [
  personEmailPersonalDomain,
  personEmailCorporateDomain,
  personLinkedinProfile,
  personHonorific,
  personTwoNameWords,
  notPersonSystemMailbox,
] as const
