/**
 * Memory nudge — post-loop utility tracking.
 *
 * After the query loop finishes, scans buffered turns for getMemory tool calls.
 * If any were found with results, makes one cheap Standard-tier call to judge
 * whether each recalled memory was actually used in the assistant's response.
 *
 * See docs/architecture/context-engine/memory-consolidation.md for the full design.
 */

import type { ContentBlock, TokenUsage } from '../providers/types.js'
import type { MemoryStore } from './types.js'

export type NudgeTurn = {
  content: ContentBlock[]
  toolResults: ContentBlock[]
}

export type NudgeModelResult = {
  text: string
  usage?: TokenUsage
  model?: string
}

export type NudgeResult = {
  /** Number of memories judged */
  judged: number
  /** Number judged as useful */
  useful: number
  /** Token usage from the judgment LLM call — null when no call was made. */
  usage: TokenUsage | null
  /** Model used for the judgment call — null when no call was made. */
  model: string | null
}

type RecalledMemory = {
  fullId: string
  prefix: string
  summary: string
}

/**
 * Extract getMemory results from buffered turns, judge utility via Standard-tier,
 * and track outcomes. Fire-and-forget from the caller.
 */
export async function runMemoryNudge(params: {
  turns: NudgeTurn[]
  callModel: (prompt: string) => Promise<NudgeModelResult | string>
  store: MemoryStore
}): Promise<NudgeResult> {
  const recalled = extractRecalledMemories(params.turns)
  if (recalled.length === 0) return { judged: 0, useful: 0, usage: null, model: null }

  const responseText = extractResponseText(params.turns)
  if (!responseText.trim()) return { judged: 0, useful: 0, usage: null, model: null }

  const prompt = buildJudgmentPrompt(recalled, responseText)
  const modelResult = await params.callModel(prompt)
  const { text, usage, model } = typeof modelResult === 'string'
    ? { text: modelResult, usage: undefined, model: undefined }
    : modelResult
  const verdicts = parseVerdicts(text, recalled)

  let useful = 0
  for (const [memoryId, isUseful] of verdicts) {
    await params.store.trackRecallOutcome(memoryId, isUseful)
    if (isUseful) useful++
  }

  return { judged: verdicts.size, useful, usage: usage ?? null, model: model ?? null }
}

/**
 * Scan turns for successful getMemory tool_result blocks.
 * Deduplicates by memory ID.
 */
function extractRecalledMemories(turns: NudgeTurn[]): RecalledMemory[] {
  const seen = new Map<string, RecalledMemory>()

  for (const turn of turns) {
    for (const block of turn.toolResults) {
      if (block.type !== 'tool_result') continue
      if (block.name !== 'getMemory') continue
      if (block.isError) continue

      try {
        const data = JSON.parse(block.content)
        // getMemory returns either a single object or an array (search results)
        const items = Array.isArray(data) ? data : [data]
        for (const item of items) {
          if (item?.id && item?.summary && !seen.has(item.id)) {
            seen.set(item.id, {
              fullId: item.id,
              prefix: item.id.slice(0, 8),
              summary: item.summary,
            })
          }
        }
      } catch {
        // Content wasn't JSON (e.g. "No matching memories found.") — skip
      }
    }
  }

  return [...seen.values()]
}

/**
 * Extract all assistant text from buffered turns.
 */
function extractResponseText(turns: NudgeTurn[]): string {
  const parts: string[] = []
  for (const turn of turns) {
    for (const block of turn.content) {
      if (block.type === 'text') {
        parts.push(block.text)
      }
    }
  }
  return parts.join('\n')
}

/**
 * Build the Standard-tier prompt for utility judgment.
 * Uses 8-char ID prefixes to match the memory index format and avoid UUID mangling.
 */
function buildJudgmentPrompt(recalled: RecalledMemory[], responseText: string): string {
  const memoryLines = recalled
    .map((m) => `[${m.prefix}] "${m.summary}"`)
    .join('\n')

  // Truncate response to ~2000 chars to keep Standard-tier prompt small
  const truncated = responseText.length > 2000
    ? responseText.slice(0, 2000) + '...'
    : responseText

  return `Judge whether recalled memories were used in the assistant's response.
A memory is USED if the response references, draws on, or was clearly informed by it.
If in doubt, output UNUSED.

RECALLED MEMORIES:
${memoryLines}

ASSISTANT RESPONSE:
${truncated}

For each memory, output one line in this exact format:
${recalled.map((m) => `${m.prefix}: USED or UNUSED`).join('\n')}`
}

/**
 * Parse Standard-tier output into memory ID -> useful verdicts.
 * Matches 8-char hex prefixes back to full UUIDs.
 */
function parseVerdicts(
  output: string,
  recalled: RecalledMemory[],
): Map<string, boolean> {
  const prefixToId = new Map(recalled.map((m) => [m.prefix, m.fullId]))
  const verdicts = new Map<string, boolean>()
  const linePattern = /^([a-f0-9]{8}):\s*(USED|UNUSED)/i

  for (const line of output.split('\n')) {
    const match = line.trim().match(linePattern)
    if (!match) continue

    const [, prefix, verdict] = match
    const fullId = prefixToId.get(prefix)
    if (fullId) {
      verdicts.set(fullId, verdict.toUpperCase() === 'USED')
    }
  }

  return verdicts
}

// Export internals for testing
export { extractRecalledMemories, extractResponseText, parseVerdicts }
