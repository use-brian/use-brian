import { createHash, createHmac } from 'node:crypto'
import { inspect } from 'node:util'
import { redactSecrets, sanitizeUnicode } from '@use-brian/core'

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
const PHONE_PATTERN = /(?<![\w-])(?:\+?\d[\d .()-]{7,}\d)(?![\w-])/g
const HOME_PATH_PATTERN = /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|[A-Z]:\\Users\\[^\\\s]+)/gi
const URL_QUERY_PATTERN = /(https?:\/\/[^\s?#]+)\?[^\s#]*/gi
const URL_FRAGMENT_PATTERN = /(https?:\/\/[^\s#]+)#[^\s]*/gi
const CREDENTIAL_ASSIGNMENT_PATTERN =
  /\b(api[_-]?key|secret|password|passwd|authorization|cookie|access[_-]?token|refresh[_-]?token)\b\s*[:=]\s*["']?[^\s,"'}]+/gi

const CONTENT_KEYS =
  /^(content|text|prompt|transcript|payload|body|input|output|arguments?|tool_?result|raw|html|markdown|query)$/i
const CREDENTIAL_KEYS =
  /(secret|token|password|passwd|authorization|cookie|credential|private.?key|api.?key)/i
const ID_KEYS = /^(?:id|.*Id|.*_id|email|phone|ip|hostname)$/

const MAX_TEXT_LENGTH = 8_000
const MAX_ARRAY_LENGTH = 50
const MAX_OBJECT_KEYS = 50
const MAX_DEPTH = 5

function shortHmac(value: string, salt: Buffer): string {
  return createHmac('sha256', salt).update(value).digest('hex').slice(0, 16)
}

export function pseudonymize(value: string, salt: Buffer, kind = 'id'): string {
  return `[${kind}:${shortHmac(value.toLowerCase(), salt)}]`
}

export function redactDiagnosticText(value: string, salt: Buffer): string {
  let text = sanitizeUnicode(value).slice(0, MAX_TEXT_LENGTH)
  text = redactSecrets(text)
  text = text.replace(URL_QUERY_PATTERN, '$1?[QUERY_REDACTED]')
  text = text.replace(URL_FRAGMENT_PATTERN, '$1#[FRAGMENT_REDACTED]')
  text = text.replace(CREDENTIAL_ASSIGNMENT_PATTERN, (_match, name: string) => `${name}=[REDACTED]`)
  text = text.replace(EMAIL_PATTERN, (match) => pseudonymize(match, salt, 'email'))
  text = text.replace(UUID_PATTERN, (match) => pseudonymize(match, salt))
  text = text.replace(IPV4_PATTERN, (match) => pseudonymize(match, salt, 'ip'))
  text = text.replace(PHONE_PATTERN, (match) => pseudonymize(match, salt, 'phone'))
  text = text.replace(HOME_PATH_PATTERN, '[HOME]')
  return text
}

function safeLogValue(value: unknown, salt: Buffer, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[DEPTH_LIMIT]'
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') {
    return value
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return redactDiagnosticText(value, salt)
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`
  if (typeof value === 'symbol') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) {
    return {
      name: redactDiagnosticText(value.name, salt),
      message: redactDiagnosticText(value.message, salt),
      stack: value.stack ? redactDiagnosticText(value.stack, salt) : undefined,
    }
  }
  if (Buffer.isBuffer(value)) return `[Buffer ${value.byteLength} bytes]`
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map((item) => safeLogValue(item, salt, depth + 1))
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {}
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS)
    for (const [key, child] of entries) {
      if (CREDENTIAL_KEYS.test(key)) {
        output[key] = '[REDACTED]'
      } else if (CONTENT_KEYS.test(key)) {
        output[key] = '[CONTENT_OMITTED]'
      } else if (typeof child === 'string' && ID_KEYS.test(key)) {
        output[key] = pseudonymize(child, salt)
      } else {
        output[key] = safeLogValue(child, salt, depth + 1)
      }
    }
    return output
  }
  return redactDiagnosticText(String(value), salt)
}

export function sanitizeDiagnosticArgs(
  args: unknown[],
  salt: Buffer,
): { message: string; fingerprint: string } {
  const safe = args.map((arg) => safeLogValue(arg, salt))
  const message = safe
    .map((value) => typeof value === 'string'
      ? value
      : inspect(value, { depth: MAX_DEPTH, breakLength: 160, compact: true }))
    .join(' ')
    .slice(0, MAX_TEXT_LENGTH)
  const fingerprint = createHash('sha256')
    .update(message.replace(/\[[a-z]+:[0-9a-f]{16}\]/gi, '[pseudonym]'))
    .digest('hex')
    .slice(0, 24)
  return { message, fingerprint }
}

/**
 * Apply the capsule's export boundary recursively. Content-bearing fields are
 * omitted unless the capture owner explicitly opted in; credential fields are
 * always omitted. IDs and direct identifiers are stable only inside one
 * capsule because every capture has a fresh HMAC salt.
 */
export function scrubCapsuleValue(
  value: unknown,
  salt: Buffer,
  options: { allowContent: boolean },
  key = '',
  depth = 0,
): unknown {
  if (depth > MAX_DEPTH) return '[DEPTH_LIMIT]'
  if (CREDENTIAL_KEYS.test(key)) return '[REDACTED]'
  if (!options.allowContent && CONTENT_KEYS.test(key)) return '[CONTENT_OMITTED]'
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') {
    return value
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') {
    if (ID_KEYS.test(key)) return pseudonymize(value, salt)
    return redactDiagnosticText(value, salt)
  }
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return `[Buffer ${value.byteLength} bytes omitted]`
  if (Array.isArray(value)) {
    return value.slice(0, 1_000).map((item) =>
      scrubCapsuleValue(item, salt, options, key, depth + 1))
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>).slice(0, 1_000)) {
      output[childKey] = scrubCapsuleValue(child, salt, options, childKey, depth + 1)
    }
    return output
  }
  return redactDiagnosticText(String(value), salt)
}
