/**
 * Context-clean Doc edit runner.
 *
 * The conversational loop can submit one self-contained brief through the
 * gateway tool below. The child starts from a new stateless context containing
 * only that brief, a freshly loaded page map, and the exact Doc tool map the
 * server captured. Parent history, persona, memories, connectors, request
 * tools, and worker lifecycle never cross this boundary.
 *
 * Spec: docs/architecture/features/doc.md -> "Context-clean edit delegation".
 *
 * [COMP:doc/edit-agent]
 */

import { z } from 'zod'
import { queryLoop } from '../engine/query-loop.js'
import type { LLMProvider, TokenUsage } from '../providers/types.js'
import { buildTool, type Tool, type ToolContext } from '../tools/types.js'

export const DOC_EDIT_GATEWAY_TOOL = 'delegateDocEdit'

/** Tools whose successful result proves the child changed durable Doc state. */
export const DOC_MUTATION_TOOLS = new Set([
  'renderPage',
  'patchPage',
  'createSubPage',
  'importToPage',
  'createEntityType',
  'addProperty',
  'removeProperty',
  'renameProperty',
  'createEntity',
  'updateEntity',
  'deleteEntity',
  'postComment',
  'resolveComment',
])

const delegateDocEditInputSchema = z
  .object({
    intent: z.enum(['create', 'edit']).describe(
      'Use edit only for an existing validated open page. Use create only when the user explicitly asked for a new page.',
    ),
    pageId: z.string().min(1).optional().describe(
      'Required for edit: the exact currently-open page id supplied by runtime context. Omit for create.',
    ),
    instruction: z.string().trim().min(1).max(20_000).describe(
      'Self-contained description of the finished page change. Include relevant facts, citations, and placement constraints. The editor cannot see this conversation.',
    ),
  })
  .superRefine((input, ctx) => {
    if (input.intent === 'edit' && !input.pageId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pageId'],
        message: 'pageId is required for an existing-page edit.',
      })
    }
    if (input.intent === 'create' && input.pageId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pageId'],
        message: 'pageId must be omitted for a new-page create.',
      })
    }
  })

export type DocEditAttemptUsage = {
  model: string
  usage: TokenUsage
  attempt: 'background' | 'standard_fallback'
}

export type DocEditReceipt = {
  status: 'completed' | 'failed'
  summary: string
  mutationTools: string[]
  pageIds: string[]
  fallbackUsed: boolean
  error?: string
}

export type RunDocEditAgentOptions = {
  provider: LLMProvider
  model: string
  fallbackModel?: string
  systemPrompt: string
  instruction: string
  tools: Map<string, Tool>
  context: ToolContext
  /** Reloaded before every attempt so a fallback never inherits stale state. */
  loadPageContext: (instruction: string) => Promise<string>
  onUsage?: (event: DocEditAttemptUsage) => void | Promise<void>
  /** Child result side channel for live UI events. It is never copied into the
   * parent transcript; the server may project selected result metadata to SSE. */
  onToolResult?: (result: {
    toolUseId: string
    name: string
    content: string
    isError?: boolean
  }) => void | Promise<void>
  maxTurns?: number
  maxToolCalls?: number
}

type AttemptResult = {
  summary: string
  mutationTools: string[]
  pageIds: string[]
  error?: string
}

/**
 * Construct the child ToolContext by allow-list, not by spreading the parent.
 * This makes the absence of requestTools/workerManager/confirmation callbacks
 * structural and reviewable.
 */
export function isolateDocEditToolContext(parent: ToolContext): ToolContext {
  return {
    userId: parent.userId,
    assistantId: parent.assistantId,
    sessionId: parent.sessionId,
    appId: parent.appId,
    channelType: parent.channelType,
    channelId: parent.channelId,
    workspaceId: parent.workspaceId,
    assistantKind: parent.assistantKind,
    activeCapabilities: parent.activeCapabilities,
    docViewId: parent.docViewId,
    userMessageText: parent.userMessageText,
    userTimezone: parent.userTimezone,
    abortSignal: parent.abortSignal,
    sensitivity: parent.sensitivity,
    compartmentAccumulator: parent.compartmentAccumulator,
    evidence: parent.evidence,
    researchMode: parent.researchMode,
    clearance: parent.clearance,
    compartments: parent.compartments,
    assistantClearance: parent.assistantClearance,
    assistantCompartments: parent.assistantCompartments,
    assistantDefaultCompartments: parent.assistantDefaultCompartments,
  }
}

function textFromContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => (
      block.type === 'text' && typeof block.text === 'string'
    ))
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function compactSummary(text: string, mutationTools: string[]): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean) return clean.slice(0, 1_000)
  return mutationTools.length > 0
    ? `Applied Doc changes with ${mutationTools.join(', ')}.`
    : 'The editor finished without applying a Doc mutation.'
}

async function runAttempt(
  options: RunDocEditAgentOptions,
  model: string,
  attempt: DocEditAttemptUsage['attempt'],
): Promise<AttemptResult> {
  const pageContext = await options.loadPageContext(options.instruction)
  const mutationTools = new Set<string>()
  const pageIds = new Set<string>()
  let latestText = ''
  let lastError: string | undefined

  try {
    for await (const event of queryLoop({
      provider: options.provider,
      model,
      systemPrompt: options.systemPrompt,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              '<doc_edit_brief>',
              options.instruction,
              '</doc_edit_brief>',
              '',
              '<fresh_page_context>',
              pageContext,
              '</fresh_page_context>',
            ].join('\n'),
          },
        ],
      }],
      tools: new Map(options.tools),
      context: isolateDocEditToolContext(options.context),
      stateless: true,
      maxTurns: options.maxTurns ?? 8,
      maxToolCalls: options.maxToolCalls ?? 16,
      channelType: 'web',
    })) {
      if (event.type === 'assistant_turn') {
        const hasToolUse = event.response.content.some((block) => block.type === 'tool_use')
        if (!hasToolUse) {
          const text = textFromContent(event.response.content)
          if (text) latestText = text
        }
        for (const result of event.toolResults) {
          if (result.type === 'tool_result') {
            await options.onToolResult?.({
              toolUseId: result.toolUseId,
              name: result.name,
              content: result.content,
              isError: result.isError,
            })
          }
          if (
            result.type === 'tool_result'
            && DOC_MUTATION_TOOLS.has(result.name)
            && result.isError !== true
          ) {
            mutationTools.add(result.name)
            try {
              const parsed = JSON.parse(result.content) as {
                pageId?: unknown
                childPageId?: unknown
              }
              if (typeof parsed.pageId === 'string') pageIds.add(parsed.pageId)
              if (typeof parsed.childPageId === 'string') pageIds.add(parsed.childPageId)
            } catch {
              // Some tools return plain text. Mutation success is still valid;
              // the compact receipt simply has no page id for that result.
            }
          }
        }
      } else if (event.type === 'turn_complete') {
        const text = textFromContent(event.response.content)
        if (text) latestText = text
        await options.onUsage?.({ model, usage: event.totalUsage, attempt })
      } else if (event.type === 'error') {
        lastError = event.error.message
      }
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
  }

  const successful = [...mutationTools]
  return {
    summary: compactSummary(latestText, successful),
    mutationTools: successful,
    pageIds: [...pageIds],
    error: lastError,
  }
}

export async function runDocEditAgent(
  options: RunDocEditAgentOptions,
): Promise<DocEditReceipt> {
  const first = await runAttempt(options, options.model, 'background')
  if (first.mutationTools.length > 0) {
    return {
      status: 'completed',
      summary: first.summary,
      mutationTools: first.mutationTools,
      pageIds: first.pageIds,
      fallbackUsed: false,
    }
  }

  const canFallback = Boolean(
    options.fallbackModel && options.fallbackModel !== options.model,
  )
  if (canFallback) {
    const fallback = await runAttempt(
      options,
      options.fallbackModel!,
      'standard_fallback',
    )
    if (fallback.mutationTools.length > 0) {
      return {
        status: 'completed',
        summary: fallback.summary,
        mutationTools: fallback.mutationTools,
        pageIds: fallback.pageIds,
        fallbackUsed: true,
      }
    }
    return {
      status: 'failed',
      summary: fallback.summary,
      mutationTools: [],
      pageIds: [],
      fallbackUsed: true,
      error: fallback.error ?? first.error ?? 'No Doc mutation was applied.',
    }
  }

  return {
    status: 'failed',
    summary: first.summary,
    mutationTools: [],
    pageIds: [],
    fallbackUsed: false,
    error: first.error ?? 'No Doc mutation was applied.',
  }
}

export function toolsForDocEditIntent(
  tools: Map<string, Tool>,
  intent: 'create' | 'edit',
): Map<string, Tool> {
  if (intent === 'create') return tools
  return new Map(
    [...tools].filter(
      ([name]) => !['renderPage', 'createSubPage', 'importToPage'].includes(name),
    ),
  )
}

export type CreateDelegateDocEditToolOptions = Omit<
  RunDocEditAgentOptions,
  'instruction' | 'context'
> & {
  /** Existing page validated and loaded by the route for this turn. */
  targetPageId?: string | null
}

export function createDelegateDocEditTool(
  options: CreateDelegateDocEditToolOptions,
): Tool<typeof delegateDocEditInputSchema> {
  // One gateway instance is minted per parent turn. Consuming it once prevents
  // a looping supervisor from spawning multiple expensive child transcripts.
  let consumed = false
  return buildTool<typeof delegateDocEditInputSchema>({
    name: DOC_EDIT_GATEWAY_TOOL,
    description:
      'Apply a requested Doc page, entity, or comment change through a fresh isolated editor. Choose edit only when runtime context supplies an existing open page id; an edit can never create a page. Choose create only when the user explicitly asks for a new page. Submit one self-contained brief after gathering needed evidence. The editor cannot see this conversation or tool results unless you include their relevant facts and source URLs. Questions that do not require a Doc mutation should be answered directly.',
    inputSchema: delegateDocEditInputSchema,
    isReadOnly: false,
    isConcurrencySafe: false,
    requiresConfirmation: false,
    timeoutMs: 180_000,
    maxResultSizeChars: 4_000,
    async execute(input, context) {
      if (consumed) {
        return {
          data: {
            status: 'failed',
            summary: 'This turn already delegated one Doc edit. Continue in a new user turn if another edit is needed.',
            mutationTools: [],
            pageIds: [],
            fallbackUsed: false,
            error: 'doc_edit_already_delegated',
          } satisfies DocEditReceipt,
          isError: true,
        }
      }
      if (input.intent === 'edit') {
        if (!options.targetPageId) {
          return {
            data: {
              status: 'failed',
              summary: 'No existing Doc page is open for this edit. Open the page first; no new page was created.',
              mutationTools: [],
              pageIds: [],
              fallbackUsed: false,
              error: 'missing_page_target',
            } satisfies DocEditReceipt,
            isError: true,
          }
        }
        if (input.pageId !== options.targetPageId) {
          return {
            data: {
              status: 'failed',
              summary: 'The requested page does not match the page validated for this turn.',
              mutationTools: [],
              pageIds: [],
              fallbackUsed: false,
              error: 'page_target_mismatch',
            } satisfies DocEditReceipt,
            isError: true,
          }
        }
      }
      consumed = true
      const tools = toolsForDocEditIntent(options.tools, input.intent)
      const receipt = await runDocEditAgent({
        ...options,
        instruction: input.instruction,
        tools,
        context,
      })
      return {
        data: receipt,
        isError: receipt.status === 'failed',
      }
    },
  })
}
