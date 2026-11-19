/** Shared model inline budget; importing it does not activate parsers. [COMP:files/parsers] */
import { estimateStringTokens } from '@use-brian/agent-runtime/compaction/compact.js'
/** Determine whether model-facing text is small enough to inline. */
const INLINE_TOKEN_THRESHOLD = 5000

export function shouldInline(text: string): boolean {
  return estimateStringTokens(text) <= INLINE_TOKEN_THRESHOLD
}
