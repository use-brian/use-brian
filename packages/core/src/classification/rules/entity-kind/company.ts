/**
 * Company classifier rules.
 *
 * Spec: docs/architecture/brain/classification/entity-kind.md §Company
 */

import type { EntityKind } from '../../../entities/types.js'
import type {
  ClassifierMatch,
  ClassifierNegativeRule,
  ClassifierRule,
} from '../../types.js'
import {
  candidateString,
  CRUNCHBASE_ORG_RE,
  isBareDomainShape,
  LEGAL_SUFFIX_RE,
  LINKEDIN_COMPANY_RE,
  normalizeDomain,
  PERSONAL_EMAIL_DOMAINS,
  TICKER_DOLLAR_RE,
  TICKER_EXCHANGE_RE,
} from './shared.js'

const ALL_BOUNDARIES = ['connector', 'tool', 'inbox', 'extraction', 'self_heal'] as const

// ── Positive rules ───────────────────────────────────────────────────

export const companyBareDomain: ClassifierRule<EntityKind> = {
  id: 'company-bare-domain',
  produces: 'company',
  tier: 'deterministic',  // PR 5 — flipped after measuring against the
                          // 646 acme.com cross-kind-collision rows. Bare
                          // domain (not personal-email-domain) is a company.
                          // not-company-personal-domain blocks gmail.com etc.
  confidence: 1.0,
  boundaries: ALL_BOUNDARIES,
  applies(c) {
    const s = candidateString(c)
    return isBareDomainShape(s) && !PERSONAL_EMAIL_DOMAINS.has(normalizeDomain(s))
  },
  evaluate(c) {
    const s = candidateString(c)
    if (!isBareDomainShape(s)) return null
    const domain = normalizeDomain(s)
    if (PERSONAL_EMAIL_DOMAINS.has(domain)) return null
    return {
      rule_id: 'company-bare-domain',
      value: 'company',
      confidence: 1.0,
      tier: 'deterministic',
      derived: { attributes: { domain } },
    } satisfies ClassifierMatch<EntityKind>
  },
}

export const companyLegalSuffix: ClassifierRule<EntityKind> = {
  id: 'company-legal-suffix',
  produces: 'company',
  tier: 'probabilistic',
  confidence: 0.95,
  boundaries: ALL_BOUNDARIES,
  applies(c) {
    return LEGAL_SUFFIX_RE.test(c.primary)
  },
  evaluate(c) {
    if (!LEGAL_SUFFIX_RE.test(c.primary)) return null
    return {
      rule_id: 'company-legal-suffix',
      value: 'company',
      confidence: 0.95,
      tier: 'probabilistic',
    } satisfies ClassifierMatch<EntityKind>
  },
}

export const companyLinkedinUrl: ClassifierRule<EntityKind> = {
  id: 'company-linkedin-url',
  produces: 'company',
  tier: 'probabilistic',
  confidence: 0.95,
  boundaries: ALL_BOUNDARIES,
  applies(c) {
    return LINKEDIN_COMPANY_RE.test(candidateString(c))
  },
  evaluate(c) {
    const s = candidateString(c)
    if (!LINKEDIN_COMPANY_RE.test(s)) return null
    return {
      rule_id: 'company-linkedin-url',
      value: 'company',
      confidence: 0.95,
      tier: 'probabilistic',
      derived: { attributes: { linkedin_url: s } },
    } satisfies ClassifierMatch<EntityKind>
  },
}

export const companyCrunchbaseUrl: ClassifierRule<EntityKind> = {
  id: 'company-crunchbase-url',
  produces: 'company',
  tier: 'probabilistic',
  confidence: 0.95,
  boundaries: ALL_BOUNDARIES,
  applies(c) {
    return CRUNCHBASE_ORG_RE.test(candidateString(c))
  },
  evaluate(c) {
    const s = candidateString(c)
    if (!CRUNCHBASE_ORG_RE.test(s)) return null
    return {
      rule_id: 'company-crunchbase-url',
      value: 'company',
      confidence: 0.95,
      tier: 'probabilistic',
      derived: { attributes: { crunchbase_url: s } },
    } satisfies ClassifierMatch<EntityKind>
  },
}

export const companyTicker: ClassifierRule<EntityKind> = {
  id: 'company-ticker-shape',
  produces: 'company',
  tier: 'probabilistic',
  confidence: 0.9,
  boundaries: ALL_BOUNDARIES,
  applies(c) {
    return TICKER_DOLLAR_RE.test(c.primary) || TICKER_EXCHANGE_RE.test(c.primary)
  },
  evaluate(c) {
    if (TICKER_DOLLAR_RE.test(c.primary)) {
      return {
        rule_id: 'company-ticker-shape',
        value: 'company',
        confidence: 0.9,
        tier: 'probabilistic',
        derived: { attributes: { ticker: c.primary.slice(1) } },
      } satisfies ClassifierMatch<EntityKind>
    }
    if (TICKER_EXCHANGE_RE.test(c.primary)) {
      const [exchange, ticker] = c.primary.split(':')
      return {
        rule_id: 'company-ticker-shape',
        value: 'company',
        confidence: 0.9,
        tier: 'probabilistic',
        derived: { attributes: { ticker, exchange } },
      } satisfies ClassifierMatch<EntityKind>
    }
    return null
  },
}

// ── Negative rules ───────────────────────────────────────────────────

export const notCompanyPersonalDomain: ClassifierNegativeRule<EntityKind> = {
  id: 'not-company-personal-domain',
  blocks: ['company'],
  tier: 'deterministic',
  boundaries: ALL_BOUNDARIES,
  applies(c) {
    const s = candidateString(c)
    if (!isBareDomainShape(s)) return false
    return PERSONAL_EMAIL_DOMAINS.has(normalizeDomain(s))
  },
  reason: 'personal email domain (gmail.com, outlook.com, etc.) — not a company',
}

// ── Bundle ───────────────────────────────────────────────────────────

export const companyRules = [
  companyBareDomain,
  companyLegalSuffix,
  companyLinkedinUrl,
  companyCrunchbaseUrl,
  companyTicker,
  notCompanyPersonalDomain,
] as const
