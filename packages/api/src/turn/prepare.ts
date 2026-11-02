import type { ExecutionContext, LLMProvider, Tool } from '@use-brian/core'
import { captureBriefRunPreparation } from '../briefs/context.js'

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
  /** Host guard before local assembly callbacks. The flag describes the exact
   * captured Brief resolver; it grants no source or delivery permission. */
  beforeAssembly?: (canonicalBrief: boolean) => Promise<void>
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
  const briefPreparation = captureBriefRunPreparation()
  const beforeAssembly = input.beforeAssembly
  const executionContext = input.executionContext, authority = executionContext.security.authority
  const assertCurrent = authority.assertCurrent, candidate = input.candidateTools, bindTools = input.bindTools
  const assertLeaseIdentity = () => {
    if (executionContext.security.authority !== authority || authority.assertCurrent !== assertCurrent) {
      throw Object.assign(new Error('The preparation authority changed.'), { reason: 'authority_changed', retrySafe: false })
    }
  }
  // The host guard owns its original lease too. Run it before invoking the
  // generic lease method so a replaced native method cannot run first.
  await beforeAssembly?.(briefPreparation.canonical)
  assertLeaseIdentity()
  await assertCurrent.call(authority)
  assertLeaseIdentity()
  const candidateTools = typeof candidate === 'function'
    ? await candidate()
    : new Map(candidate)
  const bound = await bindTools(candidateTools, executionContext)
  // Accepted Brief grounding for a Project-bound turn, below runtime policy;
  // mutating tools recheck the accepted direction before they act, and an
  // unattended run refuses an incompatible change before any provider work
  // (project-briefs.md -> "Grounding a turn", "Revision boundaries").
  const brief = await briefPreparation.apply(executionContext, bound)
  const tools = brief.tools
  const trusted = [...(input.trustedContributions ?? []), ...(brief.contribution ? [brief.contribution] : [])]
  const userVisible = input.userVisibleContributions ?? []

  return {
    executionContext,
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
