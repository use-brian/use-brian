/**
 * Bounded ring buffer for webhook deduplication.
 * Prevents processing duplicate webhooks from platform retries.
 */

const MAX_SIZE = 1000

export function createDedupBuffer() {
  const seen = new Set<string>()

  return {
    isDuplicate(id: string): boolean {
      if (seen.has(id)) return true
      seen.add(id)
      if (seen.size > MAX_SIZE) {
        // Remove oldest entry
        const first = seen.values().next().value!
        seen.delete(first)
      }
      return false
    },
  }
}
