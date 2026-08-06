/** Deterministic recording and replay for the user's local browser. */
import type { ToolContext } from '../tools/types.js'
import type { BrowserSkill, BrowserSkillRecordingStep } from './browser-skills.js'
import type { BrowserProfile } from './profiles.js'
import type {
  BlockRunResult,
  BlockSendRequest,
} from './runner-shim.js'
import type { BrowserCallContext, BrowserProvider, BrowserSnapshot } from './types.js'
import { decideTerminalSend, type SendGateOutcome } from './send-gate.js'
import type { BrowserSkillGrantStore, BlockApprovalsPort } from './browser-skills.js'

const MAX_LOCAL_SKILL_STEPS = 100

export type LocalTraceStep = {
  action: 'open' | 'click' | 'fill' | 'submit'
  url?: string | null
  /** Accessible name captured from the latest snapshot. */
  detail?: string | null
  /** Text captured from a fill operation. */
  text?: string | null
  /** Description captured for a terminal submit. */
  description?: string | null
}

export type LocalSkillRunOptions = {
  local: BrowserProvider
  context: ToolContext
  skill: BrowserSkill
  profile: BrowserProfile
  rehearsal: boolean
  input?: Record<string, unknown>
  grants?: BrowserSkillGrantStore | null
  approvals?: BlockApprovalsPort | null
  approvalWaitMs: number
  pollMs: number
  now: () => number
}

function pyString(value: string): string {
  return JSON.stringify(value)
}

/** Convert the flat-tool recording into the same governed block format as self-heal. */
export function distillLocalTrace(params: {
  trace: LocalTraceStep[]
  goal?: string
  /** Parameter name -> literal value to replace in recorded fills. */
  parameters?: Record<string, string>
}): {
  code: string
  recording: BrowserSkillRecordingStep[]
  description: string
  paramsSchema: Record<string, unknown>
} {
  const lines = ['def run(runner, params):']
  const recording: BrowserSkillRecordingStep[] = []
  const paramsSchema: Record<string, unknown> = {}
  let step = 0

  for (const traceStep of params.trace) {
    step += 1
    const label = traceStep.detail ?? ''
    switch (traceStep.action) {
      case 'open':
        if (!traceStep.url) break
        lines.push(`    runner.open(${pyString(traceStep.url)})`)
        lines.push('    runner.snapshot()')
        recording.push({ step, action: 'open', url: traceStep.url })
        break
      case 'click':
        if (!label) break
        lines.push(`    runner.click(runner.find(${pyString(label)}))`)
        lines.push('    runner.snapshot()')
        recording.push({ step, action: 'click', detail: label })
        break
      case 'fill':
        if (!label) break
        {
          const parameter = Object.entries(params.parameters ?? {}).find(([, value]) => value === (traceStep.text ?? ''))?.[0]
          const fillExpression = parameter ? `params[${pyString(parameter)}]` : pyString(traceStep.text ?? '')
          if (parameter) paramsSchema[parameter] = { type: 'string' }
          lines.push(`    runner.fill(runner.find(${pyString(label)}), ${fillExpression})`)
          recording.push({ step, action: 'fill', detail: label, text: traceStep.text ?? '', param: parameter ?? null })
        }
        break
      case 'submit':
        if (!label) break
        lines.push(
          `    runner.submit(runner.find(${pyString(label)}), ${pyString(traceStep.description ?? label)})`,
        )
        recording.push({
          step,
          action: 'submit',
          detail: label,
          description: traceStep.description ?? label,
        })
        break
    }
  }

  if (lines.length === 1) lines.push('    runner.log("empty recording - nothing to replay")')
  return {
    code: `${lines.join('\n')}\n`,
    recording,
    description: params.goal?.trim() || 'Recorded local browser actions',
    paramsSchema: { type: 'object', properties: paramsSchema, required: Object.keys(paramsSchema) },
  }
}

function findRef(snapshot: BrowserSnapshot | null, label: string | null | undefined): string | null {
  if (!snapshot || !label) return null
  const needle = label.toLowerCase()
  return snapshot.nodes.find((node) => node.name.toLowerCase().includes(needle))?.ref ?? null
}

function callContext(context: ToolContext, profile: BrowserProfile): BrowserCallContext {
  return {
    userId: context.userId,
    workspaceId: context.workspaceId ?? '',
    sessionId: context.sessionId,
    profileId: profile.id,
  }
}

/** Replay a saved recording through the local provider without model snapshots. */
export async function runLocalSkill(params: LocalSkillRunOptions): Promise<{
  result: BlockRunResult
  outcomes: SendGateOutcome[]
}> {
  const ctx = callContext(params.context, params.profile)
  const recording = [...params.skill.recording].sort((a, b) => a.step - b.step)
  const input = params.input ?? {}
  const outcomes: SendGateOutcome[] = []
  const wouldSend: Array<{ ref?: string | null; description?: string | null }> = []
  const summary: string[] = []
  let snapshot: BrowserSnapshot | null = null
  let sendNumber = 0

  const refresh = async (): Promise<void> => {
    snapshot = await params.local.snapshot(ctx)
  }
  const fail = (message: string) => ({
    result: { ok: false, error: message, wouldSend },
    outcomes,
  })

  if (recording.length === 0) return fail('The skill has no recording to replay locally.')
  if (recording.length > MAX_LOCAL_SKILL_STEPS) {
    return fail(`The skill has ${recording.length} steps, exceeding the local replay limit of ${MAX_LOCAL_SKILL_STEPS}.`)
  }

  try {
    for (const step of recording) {
      const label = step.detail ?? null
      if (step.action === 'open') {
        if (!step.url) return fail(`Recording step ${step.step} has no URL.`)
        await params.local.navigate(ctx, step.url)
        await refresh()
        summary.push(`opened ${step.url}`)
        continue
      }

      if (step.action === 'snapshot') {
        await refresh()
        continue
      }

      if (!snapshot) await refresh()
      const ref = findRef(snapshot, label)
      if (step.action === 'click' || step.action === 'fill') {
        if (!ref) return fail(`Local replay drift at step ${step.step}: could not find "${label ?? '(unnamed)'}".`)
        if (step.action === 'click') {
          await params.local.click(ctx, ref)
          await refresh()
          summary.push(`clicked ${label}`)
        } else {
          if (step.param && !Object.prototype.hasOwnProperty.call(input, step.param)) {
            return fail(`Missing required skill parameter "${step.param}" at step ${step.step}.`)
          }
          const text = step.param ? String(input[step.param]) : step.text ?? ''
          await params.local.type(ctx, ref, text)
          summary.push(`filled ${label}`)
        }
        continue
      }

      if (step.action === 'submit') {
        sendNumber += 1
        const request: BlockSendRequest = {
          n: sendNumber,
          ref,
          label,
          description: step.description ?? label,
          drift: ref ? null : `unresolved label ${label ?? '(unnamed)'} (not in the latest snapshot)`,
        }
        const { decision, outcome } = await decideTerminalSend({
          context: params.context,
          skill: params.skill,
          profile: params.profile,
          request,
          rehearsal: params.rehearsal,
          grants: params.grants,
          approvals: params.approvals,
          approvalWaitMs: params.approvalWaitMs,
          pollMs: params.pollMs,
          now: params.now,
        })
        outcomes.push(outcome)
        if (decision.stub) {
          wouldSend.push({ ref, description: request.description })
          summary.push(`would submit ${label}`)
        } else if (decision.approved) {
          if (!ref) return fail(`Local replay drift at submit step ${step.step}: target disappeared.`)
          await params.local.click(ctx, ref)
          await refresh()
          summary.push(`submitted ${label}`)
        } else {
          return fail(`Terminal send at step ${step.step} was not approved: ${decision.reason ?? 'denied'}`)
        }
      }
    }
  } catch (error) {
    return fail(`Local replay failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  return {
    result: { ok: true, summary: summary.join('\n'), wouldSend },
    outcomes,
  }
}
