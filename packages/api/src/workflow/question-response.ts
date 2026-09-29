import { createLoopDetector, createToolExecutor, type Tool, type ToolContext } from '@use-brian/core'
import { runWithAgentAccess } from '../db/client.js'
import { executeWithCurrentAuthority } from '../context-scope/authority-lease.js'
import type { ChannelQuestion } from './channel-questions.js'

/** A single typed call, not an agent turn. Fresh registry/context supplied after authorization. */
export async function dispatchQuestionResponse(
  binding: ChannelQuestion,
  answer: string,
  tools: Map<string, Tool>,
  context: ToolContext,
  claim: () => Promise<boolean>,
): Promise<string> {
  const operation = () => dispatchScopedQuestionResponse(binding, answer, tools, context, claim)
  return context.executionContext
    ? runWithAgentAccess(context.executionContext.security.ceiling, operation)
    : operation()
}

async function dispatchScopedQuestionResponse(
  binding: ChannelQuestion, answer: string, tools: Map<string, Tool>,
  context: ToolContext, claim: () => Promise<boolean>,
): Promise<string> {
  // Both the request lease and any enclosing authority must remain current.
  const boundary = <T>(operation: () => Promise<T>): Promise<T> => {
    context.abortSignal.throwIfAborted()
    const checked = () => executeWithCurrentAuthority(async () => {
      context.abortSignal.throwIfAborted()
      return operation()
    })
    return context.authority ? context.authority.execute(checked) : checked()
  }
  const stopped = 'Stopped. No response action was run.'
  if (context.abortSignal.aborted) return stopped
  const response = binding.response
  // Generic dispatch/search tools would turn a fixed name back into arbitrary
  // execution authority. Only direct connector adapters are supported.
  if (!response || ['mcp_call', 'mcp_search'].includes(response.toolName)) {
    return 'This question has no supported response action. No action was run.'
  }
  const tool = tools.get(response.toolName)
  if (!tool) return 'The response action is no longer available or allowed. No action was run.'
  const input = { ...response.arguments, [response.answerField]: answer }
  // Fail closed for Ask. Answering a question is NOT approving a tool call.
  // No policy/confirmation error or remote tool result is exposed to Telegram.
  try {
    if (await boundary(async () => tool.resolveConfirmation ? tool.resolveConfirmation(context, input) : tool.requiresConfirmation)) {
      return 'Response awaiting separate approval; no action was run and this question remains open. This reply path cannot approve Ask-policy tools. Ask the workflow author to use a supported approval flow or explicitly Allow this pinned response tool, then reply again.'
    }
  } catch { return 'The response action policy could not be verified. No action was run.' }
  if (!tool.inputSchema.safeParse(input).success) return 'The configured response arguments are invalid. No action was run; ask the workflow author to correct the binding.'
  if (context.abortSignal.aborted) return stopped
  try {
    if (!await boundary(claim)) return 'This question has expired or was already answered.'
  } catch { return context.abortSignal.aborted ? stopped : 'The response action authority could not be verified. No action was run.' }
  // A claim already in flight may finish after stop; do not execute even then.
  if (context.abortSignal.aborted) return stopped
  const executor = createToolExecutor({
    tools: new Map([[tool.name, { ...tool, resolveConfirmation: async (ctx, args) => {
      try { return await boundary(async () => tool.resolveConfirmation ? tool.resolveConfirmation(ctx, args) : tool.requiresConfirmation) }
      catch { return true }
    }, execute: (args, ctx) => {
      // The executor awaits policy again after claim. Guard the final boundary
      // too, including tools that do not themselves honor AbortSignal.
      ctx.abortSignal.throwIfAborted()
      return boundary(() => tool.execute(args, ctx))
    } }]]), context,
    loopDetector: createLoopDetector({ hardLimit: 2 }),
  })
  executor.addTool(binding.token, tool.name, input)
  let failed = false
  for await (const result of executor.getRemainingResults()) {
    failed ||= result.blocks.some((block) => block.type === 'tool_result' && block.isError === true)
  }
  return failed ? 'The response action failed. Check its status before requesting a new question.' : 'Your answer was sent.'
}
