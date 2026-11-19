/** Unit-test stand-in for the durable stored writer (migration 8277). Unit suites
 * mock the row writer (`db/sessions.js` `addSessionMessage`) and have no database;
 * the real `publishStoredTurnPublication` opens a pooled transaction for the
 * completion header, which must never reach an ambient database from a unit run.
 * This writes the same rows through the suite's mocked row writer and records the
 * completion binding it was handed, so suites can assert it. Database suites use
 * the real store. */
import { vi } from 'vitest'

export const storedCompletions: unknown[] = []

export async function storedPublicationModule(actual: Record<string, unknown>) {
  return {
    ...actual,
    publishStoredTurnPublication: vi.fn(async (input: { sessionId: string; rows: readonly object[]; write: object; completion?: unknown }) => {
      const { addSessionMessage } = await import('../../../db/sessions.js')
      const stored = []
      for (const row of input.rows) stored.push(await addSessionMessage({ sessionId: input.sessionId, ...row, ...input.write } as never))
      if (input.completion) storedCompletions.push(structuredClone(input.completion))
      return stored
    }),
  }
}

/** No unit suite has a committed completion to reconcile. */
export async function completionRecoveryModule(actual: Record<string, unknown>) {
  return { ...actual, committedTurnCompletion: vi.fn(async () => null), recordTurnCompletion: vi.fn(async () => ({})) }
}
