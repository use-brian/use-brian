import { timingSafeEqual } from 'node:crypto'

/** Constant-time, fail-closed internal connector authentication. */
export function connectorSecretMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || expected.length === 0) return false
  const actual = Buffer.from(provided)
  const wanted = Buffer.from(expected)
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}
