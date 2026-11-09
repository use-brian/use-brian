import { createHash } from 'node:crypto'
import { vi } from 'vitest'
import type { ExternalApprovalSource } from '../contracts.js'

/** Mutable fake registry for transport tests; production authority always comes from SQL. */
export function testSources(...initial: ExternalApprovalSource[]) {
  const entries = new Map(initial.map(source => [source.id, source]))
  return {
    entries,
    get: vi.fn(async (id: string) => entries.get(id) ?? null),
    authenticate: vi.fn(async (header?: string) => {
      if (!header || !/^Bearer [!-~]{16,4096}$/.test(header)) return null
      const digest = createHash('sha256').update(header.slice(7)).digest('hex')
      return [...entries.values()].find(source => source.tokenSha256 === digest) ?? null
    }),
  }
}
