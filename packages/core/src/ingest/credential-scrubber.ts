/**
 * Universal credential scrubber — pre-pipeline data hygiene.
 *
 * Before any Episode content reaches Pipeline B extraction (or is
 * persisted to `episodes.content_ref`), raw content runs through this
 * small **hardcoded** scrubber. Scope is **operational secrets only** —
 * patterns that have no legitimate business reason to be stored
 * anywhere.
 *
 *   - Private keys  (`-----BEGIN ... PRIVATE KEY-----` … `END`)
 *   - API tokens with known prefixes (`sk_`, `sk-`, `ghp_`, `xoxb-`,
 *     `AKIA*`, `AIza*`, `whsec_`, …)
 *   - JWT-shaped tokens (3-segment base64url)
 *
 * Explicitly NOT redacted: SSN, credit-card numbers, dates of birth,
 * addresses, phone numbers, names, and other business PII. Those are
 * routinely needed in legitimate operations and are protected by
 * sensitivity classification + clearance ceilings, NOT by redaction
 * (P1-9 final lock). Treating PII as redactable was an earlier design
 * mistake — see permissions.md → "Misclassification detection — no
 * extraction-time tripwire".
 *
 * Distinct from sensitivity classification: this runs *before*
 * sensitivity is assigned, never bumps a tier, never emits a drift
 * signal. It just removes credential-class strings from raw content.
 *
 * Distinct from `security/sanitize.ts::redactSecrets`: that utility
 * redacts at *output* boundaries (analytics, consolidation, worker
 * prompts) with a `[REDACTED:Name]` marker. This scrubber is the
 * *ingest* boundary with the spec-mandated `[redacted:<kind>]` marker
 * and a deliberately narrow operational-secret scope.
 *
 * Spec: docs/plans/company-brain/ingest.md → "Universal credential
 * scrubbing (pre-pipeline data hygiene)".
 *
 * [COMP:brain/credential-scrubber]
 */

/** Stable kind tags used in the `[redacted:<kind>]` replacement marker. */
type CredentialKind = 'private_key' | 'api_token' | 'jwt'

type ScrubPattern = {
  kind: CredentialKind
  /** Must carry the global flag — `scrub()` relies on `replace(/g)`. */
  pattern: RegExp
}

/**
 * Hardcoded pattern table. Ordered so the broadest, highest-confidence
 * match (private-key block) runs first; the prefix-bound token patterns
 * and the JWT shape follow. Every pattern is prefix-bound or
 * marker-bound, keeping the false-positive rate low per the "why
 * hardcoded" rationale in the spec.
 */
const SCRUB_PATTERNS: ScrubPattern[] = [
  // PEM-style private key blocks (RSA / EC / OPENSSH / generic). The
  // `[\s\S]` body match is non-greedy so two adjacent keys collapse to
  // two markers, not one.
  {
    kind: 'private_key',
    pattern:
      /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
  },
  // AWS access key id.
  { kind: 'api_token', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  // Google API key.
  { kind: 'api_token', pattern: /\bAIza[a-zA-Z0-9_-]{35}\b/g },
  // GitHub personal-access / OAuth / refresh / server / user tokens.
  { kind: 'api_token', pattern: /\bgh[pousr]_[a-zA-Z0-9]{36,}\b/g },
  // Slack bot/user/app/refresh/legacy tokens.
  { kind: 'api_token', pattern: /\bxox[bpras]-[a-zA-Z0-9-]{10,}\b/g },
  // Stripe-style secret keys (`sk_live_…` / `sk_test_…`).
  { kind: 'api_token', pattern: /\bsk_(?:live|test)_[a-zA-Z0-9]{16,}\b/g },
  // Stripe webhook signing secret.
  { kind: 'api_token', pattern: /\bwhsec_[a-zA-Z0-9]{20,}\b/g },
  // Anthropic / OpenAI-style `sk-` keys (incl. `sk-ant-…`).
  { kind: 'api_token', pattern: /\bsk-(?:ant-)?[a-zA-Z0-9_-]{20,}\b/g },
  // JWT-shaped 3-segment base64url tokens. Runs last so a JWT used as a
  // bearer credential is still caught, while the more specific prefixed
  // tokens above win when they apply.
  {
    kind: 'jwt',
    pattern: /\beyJ[a-zA-Z0-9_-]{8,}\.eyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g,
  },
]

export type ScrubResult = {
  /** Content with every credential-class match replaced by `[redacted:<kind>]`. */
  text: string
  /** True iff at least one redaction was applied. */
  redacted: boolean
  /** Count of redactions applied per kind (only kinds that fired appear). */
  counts: Partial<Record<CredentialKind, number>>
}

/**
 * Scrub operational secrets from `input`. Returns the scrubbed text plus
 * a small report. The unscrubbed input is the caller's to discard — per
 * spec the raw content is **never persisted**.
 *
 * Idempotent: running `scrub()` on already-scrubbed text is a no-op
 * (the `[redacted:<kind>]` marker matches none of the patterns).
 */
export function scrubCredentials(input: string): ScrubResult {
  const counts: Partial<Record<CredentialKind, number>> = {}
  let text = input

  for (const { kind, pattern } of SCRUB_PATTERNS) {
    // Global regexes are stateful via lastIndex — reset before use so a
    // shared module-level RegExp is safe across calls.
    pattern.lastIndex = 0
    text = text.replace(pattern, () => {
      counts[kind] = (counts[kind] ?? 0) + 1
      return `[redacted:${kind}]`
    })
  }

  const redacted = Object.keys(counts).length > 0
  return { text, redacted, counts }
}

/**
 * Convenience wrapper — returns just the scrubbed string. Use when the
 * caller does not need the redaction report.
 */
export function scrubCredentialsText(input: string): string {
  return scrubCredentials(input).text
}
