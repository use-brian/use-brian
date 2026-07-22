import { timingSafeEqual } from 'node:crypto'

/**
 * Constant-time X-Connector-Secret check for the internal bridge.
 * Fails closed: an empty/unset expected secret matches nothing, so a
 * misconfigured deployment rejects every caller instead of comparing
 * against `undefined`/`''` and waving matching garbage through.
 */
export function connectorSecretMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || expected.length === 0) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
