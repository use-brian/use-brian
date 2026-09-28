import type { ExecutionContext, LLMProvider, Tool } from '@use-brian/core'

export type PreparedModelSelection = {
  provider: LLMProvider
  model: string
  maxTokens?: number
  inputTokenLimit?: number
}

export type NamedRunContribution = {
  name: string
  content: string
}

export type PrepareAssistantRunInput = {
  executionContext: ExecutionContext
  model: PreparedModelSelection
  candidateTools: Map<string, Tool> | (() => Map<string, Tool> | Promise<Map<string, Tool>>)
  bindTools: (
    tools: Map<string, Tool>,
    executionContext: ExecutionContext,
  ) => Map<string, Tool> | Promise<Map<string, Tool>>
  trustedContributions?: readonly NamedRunContribution[]
  userVisibleContributions?: readonly NamedRunContribution[]
  finalizers?: readonly (() => void | Promise<void>)[]
}

export type PreparedAssistantRun = {
  executionContext: ExecutionContext
  model: PreparedModelSelection
  tools: Map<string, Tool>
  trustedContext: string
  userVisibleContext: string
  contributionNames: { trusted: string[]; userVisible: string[] }
  cleanup(): Promise<void>
}

function assemble(contributions: readonly NamedRunContribution[]): string {
  return contributions
    .map(({ content }) => content.trim())
    .filter(Boolean)
    .join('\n\n')
}

/** Common, transport-free preparation for the four model execution adapters. */
export async function prepareAssistantRun(
  input: PrepareAssistantRunInput,
): Promise<PreparedAssistantRun> {
  await input.executionContext.security.authority.assertCurrent()
  const candidateTools = typeof input.candidateTools === 'function'
    ? await input.candidateTools()
    : new Map(input.candidateTools)
  const tools = await input.bindTools(candidateTools, input.executionContext)
  const trusted = input.trustedContributions ?? []
  const userVisible = input.userVisibleContributions ?? []
  let cleaned = false

  return {
    executionContext: input.executionContext,
    model: input.model,
    tools,
    trustedContext: assemble(trusted),
    userVisibleContext: assemble(userVisible),
    contributionNames: {
      trusted: trusted.map(({ name }) => name),
      userVisible: userVisible.map(({ name }) => name),
    },
    async cleanup() {
      if (cleaned) return
      cleaned = true
      await Promise.allSettled((input.finalizers ?? []).map((finalize) => finalize()))
    },
  }
}
