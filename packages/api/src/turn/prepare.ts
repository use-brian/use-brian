import type { ExecutionContext, LLMProvider, Tool } from '@use-brian/core'
import { applyBriefToRun } from '../briefs/context.js'

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
}

export type PreparedAssistantRun = {
  executionContext: ExecutionContext
  model: PreparedModelSelection
  tools: Map<string, Tool>
  trustedContext: string
  userVisibleContext: string
  contributionNames: { trusted: string[]; userVisible: string[] }
}

function assemble(contributions: readonly NamedRunContribution[]): string {
  return contributions
    .map(({ content }) => content.trim())
    .filter(Boolean)
    .join('\n\n')
}

/**
 * The kernel's assembly stage (unified-sessions section 4.3, stage 6-7):
 * transport-free preparation every runner hands `runAssistantTurn`. Binds the
 * candidate tools to the execution's access once, and assembles the trusted
 * (private runtime) and user-visible contributions by name.
 *
 * [COMP:api/turn-kernel]
 */
export async function prepareAssistantRun(
  input: PrepareAssistantRunInput,
): Promise<PreparedAssistantRun> {
  await input.executionContext.security.authority.assertCurrent()
  const candidateTools = typeof input.candidateTools === 'function'
    ? await input.candidateTools()
    : new Map(input.candidateTools)
  const bound = await input.bindTools(candidateTools, input.executionContext)
  // Accepted Brief grounding for a Project-bound turn, below runtime policy;
  // mutating tools recheck the accepted direction before they act, and an
  // unattended run refuses an incompatible change before any provider work
  // (project-briefs.md -> "Grounding a turn", "Revision boundaries").
  const brief = await applyBriefToRun(input.executionContext, bound)
  const tools = brief.tools
  const trusted = [...(input.trustedContributions ?? []), ...(brief.contribution ? [brief.contribution] : [])]
  const userVisible = input.userVisibleContributions ?? []

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
  }
}
