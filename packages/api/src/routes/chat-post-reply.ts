import type { ContentBlock } from '@use-brian/core'
import { isAuthorityChangedError } from '../context-scope/authority-lease.js'
import type { TurnLoopResult } from '../turn/kernel.js'

/** Outcome tracking only: this never renews or bypasses the original authority. */
export function createChatPostReplyBoundary() {
  let finalizing = false
  let published = false
  let signal: AbortSignal | undefined
  return {
    beginFinalization(result: TurnLoopResult, providerFailed: boolean, abortSignal: AbortSignal) {
      signal = abortSignal
      finalizing = result.selection.kind === 'text' && !result.aborted && !providerFailed
    },
    /** Call only for the last row, after publication, authority checks and notification. */
    recordPublishedReply(content: ContentBlock[]) {
      published = finalizing && !content.some(block => block.type === 'tool_use')
        && content.some(block => block.type === 'text' && block.text.trim().length > 0)
    },
    notice(error: unknown): { code: string; message: string } | null {
      if (!published || signal?.aborted || !isAuthorityChangedError(error)
        || error.operationMayHaveExecuted !== false) return null
      return {
        code: 'post_reply_authority_changed',
        message: 'Your reply was saved. Some follow-up processing stopped because access changed. Your next message will use the current permissions.',
      }
    },
  }
}
