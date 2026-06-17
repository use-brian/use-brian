/**
 * Class-level naming validator (S10).
 *
 * Hermes invariant: an auto-generated umbrella skill must describe a *class*
 * of tasks, not a transient session artefact. The curator agent has a
 * tendency to name a new umbrella after the bug it just helped debug, the PR
 * it just touched, or the literal error string the user pasted in. That
 * naming choice creates skills that won't survive the next week — the next
 * occurrence will look semantically dissimilar, the curator will try to
 * create another sibling, and the workspace fills with narrow lookalikes.
 *
 * This validator runs on `create_umbrella` only. `patch_skill`, `update_umbrella`,
 * and `add_support_file` all operate on existing skills whose name was already
 * accepted (either by an earlier umbrella decision or by direct user authorship),
 * so re-validating them would just churn legacy data.
 *
 * The validator is a pure function — no DB, no I/O. The background-review
 * worker uses the rejection reason in a single re-prompt; second failure
 * logs `skill_review_action_failed` and skips.
 *
 * Spec: `docs/architecture/engine/skill-system.md` →
 *   "Class-level naming validator on `create_umbrella` only".
 *
 * [COMP:skills/class-name-validator]
 */

export type ClassNameValidationResult =
  | { ok: true }
  | { ok: false; reason: string }

/**
 * Banned prefix patterns. Matched against the lower-cased trimmed name.
 * Order matters only for which message wins — every entry is independent.
 */
const BANNED_PREFIXES: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /^fix[\s\-_]/i,
    reason:
      'Names starting with "fix-" describe a one-off repair, not a reusable class of task. ' +
      'Rename to the class of work (e.g. "debugging-stripe-webhooks" → "stripe-webhook-troubleshooting").',
  },
  {
    pattern: /^debug[\s\-_]/i,
    reason:
      'Names starting with "debug-" describe a session-specific investigation, not a class. ' +
      'Rename to the general procedure (e.g. "debug-oauth-redirect" → "oauth-redirect-troubleshooting").',
  },
  {
    pattern: /^audit[\s\-_]/i,
    reason:
      'Names starting with "audit-" describe a one-off review, not a class of task. ' +
      'Rename to the recurring procedure if there is one, or skip umbrella creation.',
  },
  {
    pattern: /^today[\s\-_]/i,
    reason:
      'Names starting with "today-" tie the skill to a single day; tomorrow it will not match the situation. ' +
      'Strip the temporal qualifier and name the class of task.',
  },
  {
    pattern: /^error[\s\-_]/i,
    reason:
      'Names starting with "error-" attach the skill to a specific failure string rather than the class of problem. ' +
      'Use the recovery procedure as the umbrella name (e.g. "error-429-rate-limit" → "rate-limit-handling").',
  },
]

/** Year-prefix patterns. Catches `2024-`, `2025-`, `2026-`, ... */
const DATED_PREFIX_RE = /^(19|20)\d{2}[\s\-_/.]/

/** PR-number patterns. Catches `pr-123`, `pr_45`, `#42`, `PR#42`, `pr/9`. */
const PR_NUMBER_RE = /^(pr[\s\-_/#]?\d+|#\d+|pr#\d+)/i

/**
 * Substrings that look like literal error messages copied from logs.
 * Detected anywhere in the name (not just prefix) because curator drafts
 * sometimes wrap the error in a generic prefix ("handle-econnreset-error").
 */
const ERROR_SUBSTRINGS = [
  'econnreset',
  'econnrefused',
  'etimedout',
  'enotfound',
  'eaddrinuse',
  'eperm',
  'null pointer',
  'undefined is not',
  'cannot read property',
  'cannot read properties of',
  'segfault',
  'segmentation fault',
  'out of memory',
  'stack overflow',
]

/**
 * Validate that a proposed umbrella name describes a class of task rather
 * than a session-specific artefact. Returns a structured result so the
 * caller can surface the human-readable reason verbatim to the LLM in the
 * re-prompt.
 *
 * The check is intentionally conservative — false positives are cheap
 * (one extra re-prompt), false negatives are expensive (a polluted skill
 * library). When in doubt, reject.
 */
export function validateClassLevelName(name: string): ClassNameValidationResult {
  if (typeof name !== 'string') {
    return { ok: false, reason: 'Name must be a string.' }
  }

  const trimmed = name.trim()
  if (trimmed.length === 0) {
    return { ok: false, reason: 'Name must be a non-empty string.' }
  }

  // Bound the size of the skill library and surface obvious typos early.
  if (trimmed.length > 80) {
    return {
      ok: false,
      reason:
        `Name is ${trimmed.length} characters; umbrella names must be 80 characters or fewer. ` +
        'Long names usually indicate session-specific detail that belongs in the body, not the name.',
    }
  }

  const lower = trimmed.toLowerCase()

  for (const { pattern, reason } of BANNED_PREFIXES) {
    if (pattern.test(lower)) {
      return { ok: false, reason }
    }
  }

  if (DATED_PREFIX_RE.test(lower)) {
    return {
      ok: false,
      reason:
        'Names that start with a year tie the skill to a calendar moment. ' +
        'Strip the date and name the class of task — the skill should still apply next year.',
    }
  }

  if (PR_NUMBER_RE.test(lower)) {
    return {
      ok: false,
      reason:
        'Names tied to a specific PR or issue number describe a one-off change, not a reusable class. ' +
        'Rename to the underlying procedure or process the PR exposed.',
    }
  }

  // Normalize separator: convert any run of dashes/underscores/spaces to a
  // single space so "cannot-read-property" and "cannot read property" both
  // match the same substring entry.
  const normalised = lower.replace(/[-_]+/g, ' ')
  for (const sub of ERROR_SUBSTRINGS) {
    if (normalised.includes(sub) || lower.includes(sub)) {
      return {
        ok: false,
        reason:
          `Name contains the literal error fragment "${sub}". ` +
          'The umbrella should describe the recovery procedure, not the verbatim error string.',
      }
    }
  }

  return { ok: true }
}
