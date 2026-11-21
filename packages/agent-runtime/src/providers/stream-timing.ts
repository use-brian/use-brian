/** Request-owned, content-free stream timing correlation. [COMP:providers/wrappers] */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

type ProviderPhase = 'pre_loop' | 'loop' | 'post_loop'
type ProviderRun = { traceId: string; ordinal: number; phase: ProviderPhase; active: boolean }
const storage = new AsyncLocalStorage<ProviderRun>()

export async function withProviderStreamTiming<T>(run: (traceId: string) => Promise<T>): Promise<T> {
  const context: ProviderRun = { traceId: `pt-${randomUUID()}`, ordinal: 0, phase: 'pre_loop', active: true }
  try {
    return await storage.run(context, () => run(context.traceId))
  } finally {
    context.active = false
  }
}

export function markProviderStreamPhase(phase: ProviderPhase): void {
  const context = storage.getStore()
  if (context?.active) context.phase = phase
}

export function startProviderStreamTiming() {
  const context = storage.getStore()
  if (!context?.active) return undefined
  return {
    provider_trace_id: context.traceId,
    provider_stream_ordinal: ++context.ordinal,
    provider_phase: context.phase,
  }
}
