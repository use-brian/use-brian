/**
 * Security sanitization utilities.
 *
 * Unicode sanitization: NFKC normalization, strip zero-width chars, directional marks.
 * Secret redaction: curated regex patterns for common API keys and secrets.
 * Applied to all external data: MCP results, file content, webhook payloads.
 */

// ── Unicode sanitization ───────────────────────────────────────

// Zero-width and directional characters that can be used for prompt injection
const DANGEROUS_UNICODE = /[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/g

/**
 * Sanitize unicode in external data.
 * NFKC normalization + strip zero-width/directional chars.
 */
export function sanitizeUnicode(input: string): string {
  return input.normalize('NFKC').replace(DANGEROUS_UNICODE, '')
}

/**
 * Recursively sanitize all string values in an object.
 */
export function sanitizeDeep(obj: unknown): unknown {
  if (typeof obj === 'string') return sanitizeUnicode(obj)
  if (Array.isArray(obj)) return obj.map(sanitizeDeep)
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = sanitizeDeep(value)
    }
    return result
  }
  return obj
}

// ── Secret redaction ───────────────────────────────────────────

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'AWS', pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'Anthropic', pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/g },
  { name: 'OpenAI', pattern: /sk-[a-zA-Z0-9]{20,}/g },
  { name: 'Stripe', pattern: /sk_(?:live|test)_[a-zA-Z0-9]{20,}/g },
  { name: 'Stripe webhook', pattern: /whsec_[a-zA-Z0-9]{20,}/g },
  { name: 'Google API', pattern: /AIza[a-zA-Z0-9_-]{35}/g },
  { name: 'GitHub', pattern: /gh[pousr]_[a-zA-Z0-9]{36,}/g },
  { name: 'Slack token', pattern: /xox[bpras]-[a-zA-Z0-9-]{10,}/g },
  { name: 'Telegram token', pattern: /\d{8,10}:[a-zA-Z0-9_-]{35}/g },
  { name: 'Generic bearer', pattern: /Bearer\s+[a-zA-Z0-9._-]{20,}/g },
  { name: 'JWT', pattern: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g },
]

/**
 * Redact known secret patterns from text.
 * Used at every output boundary: analytics, consolidation, SOUL synthesis,
 * worker prompts, cron results.
 */
export function redactSecrets(text: string): string {
  let result = text
  for (const { name, pattern } of SECRET_PATTERNS) {
    // Reset lastIndex for global regex
    pattern.lastIndex = 0
    result = result.replace(pattern, `[REDACTED:${name}]`)
  }
  return result
}

/**
 * Check if text contains any known secret patterns.
 */
export function containsSecrets(text: string): boolean {
  for (const { pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(text)) return true
  }
  return false
}
