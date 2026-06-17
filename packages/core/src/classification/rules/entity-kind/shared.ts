/**
 * Shared regex + helper utilities for entity-kind classifier rules.
 *
 * Spec: docs/architecture/brain/classification/entity-kind.md
 */

import type { ClassifierCandidate } from '../../types.js'

// ── Email helpers ────────────────────────────────────────────────────

/** Personal email domains that suppress company classification. */
export const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'protonmail.com',
  'proton.me',
  'fastmail.com',
  'zoho.com',
  'aol.com',
  'mail.com',
  'tutanota.com',
])

/** System mailbox local-parts that suppress person classification. */
export const SYSTEM_MAILBOX_LOCAL_PARTS = new Set([
  'no-reply',
  'noreply',
  'no_reply',
  'donotreply',
  'do-not-reply',
  'notifications',
  'notification',
  'support',
  'help',
  'hello',
  'info',
  'admin',
  'postmaster',
  'mailer-daemon',
  'mailer',
  'bounce',
  'bounces',
  'feedback',
])

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i

export function isEmailShape(s: string | null | undefined): s is string {
  return typeof s === 'string' && EMAIL_RE.test(s)
}

export function emailLocal(email: string): string {
  return email.split('@')[0]!.toLowerCase()
}

export function emailDomain(email: string): string {
  return email.split('@')[1]!.toLowerCase()
}

// ── Domain helpers ───────────────────────────────────────────────────

// Bare registrable domain. No path, no `@`, at least one dot, ASCII only.
// Doesn't validate TLD existence (would need an external list); the URL
// rules below pick up `http://` and `https://` separately.
const BARE_DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i
const PATH_OR_QUERY_RE = /[\/?#]/

export function isBareDomainShape(s: string | null | undefined): s is string {
  if (typeof s !== 'string') return false
  if (s.includes('@')) return false
  if (PATH_OR_QUERY_RE.test(s)) return false
  return BARE_DOMAIN_RE.test(s)
}

export function normalizeDomain(s: string): string {
  return s.toLowerCase().replace(/^www\./, '')
}

// ── URL helpers ──────────────────────────────────────────────────────

const URL_RE = /^https?:\/\//i

export function isUrl(s: string | null | undefined): s is string {
  return typeof s === 'string' && URL_RE.test(s)
}

// GitHub repo URL — captures owner + repo. Excludes sub-paths
// (`/pull/`, `/issues/`, etc.) by anchoring on optional trailing slash
// followed by end. Accepts `.git` suffix for clone URLs.
export const GITHUB_REPO_RE =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/(?<owner>[a-z0-9][a-z0-9-]*)\/(?<repo>[a-z0-9][a-z0-9-_.]*?)(?:\.git)?\/?$/i

// GitHub account URL — single path segment. Could be user or org.
export const GITHUB_ACCOUNT_RE =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/(?<owner>[a-z0-9][a-z0-9-]*)\/?$/i

export const GITLAB_REPO_RE =
  /^(?:https?:\/\/)?(?:www\.)?gitlab\.com\/(?<owner>[a-z0-9][a-z0-9-_.]*?)\/(?<repo>[a-z0-9][a-z0-9-_.]*?)(?:\.git)?\/?$/i

export const BITBUCKET_REPO_RE =
  /^(?:https?:\/\/)?bitbucket\.org\/(?<owner>[a-z0-9][a-z0-9-_.]*?)\/(?<repo>[a-z0-9][a-z0-9-_.]*?)\/?$/i

export const LINKEDIN_PROFILE_RE =
  /^(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[^/]+\/?$/i

export const LINKEDIN_COMPANY_RE =
  /^(?:https?:\/\/)?(?:www\.)?linkedin\.com\/company\/[^/]+\/?$/i

export const CRUNCHBASE_ORG_RE =
  /^(?:https?:\/\/)?(?:www\.)?crunchbase\.com\/organization\/[^/]+\/?$/i

// Stock ticker patterns
export const TICKER_DOLLAR_RE = /^\$[A-Z]{1,5}$/
export const TICKER_EXCHANGE_RE = /^(NYSE|NASDAQ|LSE|HKEX|TSE|TYO|ASX|SHA|SHE):[A-Z0-9.]+$/

// Legal-suffix patterns for company names (trailing, case-insensitive)
export const LEGAL_SUFFIX_RE =
  /\b(inc|incorporated|ltd|limited|llc|l\.l\.c\.|corp|corporation|gmbh|k\.k\.|pte(?:\.?\s+ltd)?|s\.a\.(?:r\.l\.)?|b\.v\.|n\.v\.|ab|oy|holdings|holding|group)\.?\s*$/i

// Honorific titles
export const HONORIFIC_RE = /^(Mr\.?|Mrs\.?|Ms\.?|Dr\.?|Prof\.?|Sir|Lord|Lady|Hon\.?)\s+/

// Two-name-word pattern (heuristic for names)
export const NAME_TWO_WORDS_RE = /^[A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?\s+[A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?(?:\s+[A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?)?$/

// ── Candidate inspectors ─────────────────────────────────────────────

/**
 * Returns the "best" string from the candidate to test — preferring
 * canonical_id when present, falling back to primary. Used by rules
 * that match on either identity or surface name.
 */
export function candidateString(c: ClassifierCandidate): string {
  return (c.canonical_id ?? c.primary).trim()
}
