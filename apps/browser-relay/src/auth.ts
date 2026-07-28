import { timingSafeEqual } from 'node:crypto'

/**
 * Constant-time X-Relay-Secret check for the internal command API.
 * Fails closed: an empty/unset expected secret matches nothing (the
 * discord-connector pattern).
 */
export function relaySecretMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || expected.length === 0) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
