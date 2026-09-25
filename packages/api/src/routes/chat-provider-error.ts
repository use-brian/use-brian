import { summarizeProviderError, type ContentBlock } from '@use-brian/core'

/** No model/tool work: keep the original evidence in its existing paired rows. */
export async function closeProviderError(options: {
  error: Error
  turns: ReadonlyArray<{ content: ContentBlock[]; toolResults: ContentBlock[] }>
  hasDeliveredText: boolean
  alreadyDelivered: boolean
  signal: AbortSignal
  canWrite: () => Promise<boolean>
  persist: (text: string) => Promise<void>
  deliver: (text: string) => void
}): Promise<boolean> {
  // Streamed text (and even a buffered text turn) is not proof of a
  // completed answer when the engine reports failure. Always close explicitly.
  if (options.signal.aborted || options.alreadyDelivered) return false
  // Read the lease AND cross-process stop request immediately before writing;
  // the periodic heartbeat alone can be stale when a provider times out.
  if (!await options.canWrite() || options.signal.aborted) return false
  const { category } = summarizeProviderError(options.error)
  const timedOut = /idle|timed?\s*out|timeout/i.test(options.error.message)
  const hasTools = options.turns.some((turn) => turn.content.some((b) => b.type === 'tool_use'))
  const text = (category === 'rate_limit'
    ? 'The model provider rate limit was reached before it could compose a final response.'
    : timedOut
    ? 'The model timed out before it could compose a final response.'
    : 'The model connection failed before it could compose a final response.')
    + (hasTools
      ? ' The tool activity and results already recorded are preserved in this conversation, but the request may be incomplete. No additional tools were run to produce this message. Review the existing results before retrying actions that may already have completed.'
      : ' The response may be incomplete. Please try again.')
  await options.persist(text)
  if (!options.signal.aborted) options.deliver(text)
  return true
}
