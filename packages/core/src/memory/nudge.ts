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
import type {
  DecisionCompletionRoute,
  DecisionExecutionPort,
  DecisionResponse,
} from '../decisions/index.js'

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
  callModel: (
    prompt: string,
    llm?: DecisionCompletionRoute,
  ) => Promise<NudgeModelResult | string>
  store: MemoryStore
  decisionRuntime?: DecisionExecutionPort
  llm?: DecisionCompletionRoute
  workspaceId?: string
  runId?: string
}): Promise<NudgeResult> {
  const recalled = extractRecalledMemories(params.turns)
  if (recalled.length === 0) return { judged: 0, useful: 0, usage: null, model: null }

  const responseText = extractResponseText(params.turns)
  if (!responseText.trim()) return { judged: 0, useful: 0, usage: null, model: null }

  const decision = params.decisionRuntime
      ? (await params.decisionRuntime.run<MemoryDecision>({
        ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
        ...(params.llm ? { llm: params.llm } : {}),
        request: {
          runId: params.runId ?? `memory-usefulness-${Date.now()}`,
          operation: {
            id: 'memory.usefulness',
            version: '1',
            stateVersion: '1',
            questionVersion: '1',
          },
          state: {
            recalled: recalled.map((memory) => ({ id: memory.fullId, summary: memory.summary })),
            response: responseText.length > 2000 ? `${responseText.slice(0, 2000)}...` : responseText,
          },
          questions: recalled.map((memory) => ({
            kind: 'boolean' as const,
            id: memory.fullId,
            prompt: `Was this memory used in the assistant response? Memory: ${memory.summary}`,
            criteria: {
              true: 'The response references, draws on, or was clearly informed by the memory',
              false: 'The response did not use the memory, including when uncertain',
            },
          })),
        },
        operation: {
          decide: (response, { profile }) => decideMemoryUsefulness(response, recalled, profile?.policy),
          validateResult: (result) => validateMemoryDecision(result, recalled),
          safeFailure: () => ({ verdicts: [], usage: null, model: null }),
          async completeWithLlm(context) {
            const result = await judgeMemoriesWithLlm(params.callModel, recalled, responseText, context.llm)
            return {
              result,
              providerId: context.llm.provider.name,
              model: { catalogId: context.llm.modelId, wireId: result.model ?? context.llm.modelId },
              ...(result.usage ? {
                usage: {
                  inputTokens: result.usage.inputTokens,
                  outputTokens: result.usage.outputTokens,
                },
              } : {}),
            }
          },
        },
      })).result
    : validateMemoryDecision(
        await judgeMemoriesWithLlm(params.callModel, recalled, responseText),
        recalled,
      )

  const verdicts = new Map(decision.verdicts)

  let useful = 0
  for (const [memoryId, isUseful] of verdicts) {
    await params.store.trackRecallOutcome(memoryId, isUseful)
    if (isUseful) useful++
  }

  return {
    judged: verdicts.size,
    useful,
    usage: decision.usage,
    model: decision.model,
  }
}

type MemoryDecision = {
  verdicts: Array<[memoryId: string, useful: boolean]>
  usage: TokenUsage | null
  model: string | null
}

function decideMemoryUsefulness(
  response: DecisionResponse,
  recalled: RecalledMemory[],
  policy: import('../decisions/index.js').JsonValue | undefined,
) {
  const uncertaintyMin = typeof policy === 'object' && policy !== null && !Array.isArray(policy)
    && typeof policy.uncertaintyMin === 'number'
    ? policy.uncertaintyMin
    : undefined
  const uncertaintyMax = typeof policy === 'object' && policy !== null && !Array.isArray(policy)
    && typeof policy.uncertaintyMax === 'number'
    ? policy.uncertaintyMax
    : undefined
  const answers = new Map(response.answers.map((answer) => [answer.questionId, answer]))
  const verdicts: Array<[string, boolean]> = []
  for (const memory of recalled) {
    const answer = answers.get(memory.fullId)
    if (answer?.kind !== 'boolean') return { kind: 'unavailable' as const, reason: 'invalid_response' as const }
    if (
      answer.pTrue !== undefined && uncertaintyMin !== undefined && uncertaintyMax !== undefined &&
      answer.pTrue >= uncertaintyMin && answer.pTrue <= uncertaintyMax
    ) {
      return { kind: 'follow_up' as const, reason: 'uncertain' as const }
    }
    verdicts.push([memory.fullId, answer.value])
  }
  return {
    kind: 'complete' as const,
    result: {
      verdicts,
      usage: response.usage
        ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens }
        : null,
      model: response.model.wireId,
    },
  }
}

function validateMemoryDecision(
  result: MemoryDecision,
  recalled: RecalledMemory[],
): MemoryDecision {
  const expected = new Set(recalled.map((memory) => memory.fullId))
  const actual = new Set<string>()
  for (const [memoryId, useful] of result.verdicts) {
    if (!expected.has(memoryId) || actual.has(memoryId) || typeof useful !== 'boolean') {
      throw new Error('memory usefulness returned an invalid verdict set')
    }
    actual.add(memoryId)
  }
  if (actual.size !== 0 && actual.size !== expected.size) {
    throw new Error('memory usefulness returned an incomplete verdict set')
  }
  return result
}

async function judgeMemoriesWithLlm(
  callModel: (prompt: string, llm?: DecisionCompletionRoute) => Promise<NudgeModelResult | string>,
  recalled: RecalledMemory[],
  responseText: string,
  llm?: DecisionCompletionRoute,
): Promise<MemoryDecision> {
  const modelResult = await callModel(buildJudgmentPrompt(recalled, responseText), llm)
  const { text, usage, model } = typeof modelResult === 'string'
    ? { text: modelResult, usage: undefined, model: undefined }
    : modelResult
  return {
    verdicts: [...parseVerdicts(text, recalled)],
    usage: usage ?? null,
    model: model ?? null,
  }
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
