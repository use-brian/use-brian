/** Shared terminal-send governance for cloud and local skill execution. */
import type { ToolContext } from '../tools/types.js'
import type { BrowserProfile } from './profiles.js'
import type {
  BlockApprovalStatus,
  BlockApprovalsPort,
  BlockSendApprovalPayload,
  BrowserSkill,
  BrowserSkillGrantStore,
} from './browser-skills.js'
import type { BlockSendDecision, BlockSendRequest } from './runner-shim.js'
import { checkVerbCeiling } from './verb-ceiling.js'

/** Accessible labels that turn an ordinary click into a governed terminal send. */
export const SEND_LIKE_LABEL_PATTERN =
  /\b(send|submit|post|publish|share|buy|pay|purchase|order|confirm|delete|apply)\b/i

export type SendGateOutcome =
  | { kind: 'stubbed' }
  | { kind: 'auto_approved'; grantId: string }
  | { kind: 'approved'; approvalId: string }
  | { kind: 'denied'; reason: string; approvalId?: string }

export type DecideTerminalSendParams = {
  context: Pick<ToolContext, 'userId' | 'sessionId'>
  skill: BrowserSkill
  profile: BrowserProfile
  request: BlockSendRequest
  rehearsal: boolean
  grants?: BrowserSkillGrantStore | null
  approvals?: BlockApprovalsPort | null
  approvalWaitMs: number
  pollMs: number
  now: () => number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function approvalPayload(
  skill: BrowserSkill,
  profile: BrowserProfile,
  request: BlockSendRequest,
  ceiling: string | null,
): BlockSendApprovalPayload {
  return {
    skillId: skill.id,
    skillName: skill.name,
    profileId: profile.id,
    profileName: profile.name,
    site: skill.site,
    ref: request.ref,
    label: request.label,
    description: request.description,
    ceiling,
    drift: request.drift ?? null,
    contractSummary: `${skill.contract.terminalSends.length} terminal send(s); v${skill.version}`,
  }
}

export async function decideTerminalSend(
  params: DecideTerminalSendParams,
): Promise<{ decision: BlockSendDecision; outcome: SendGateOutcome }> {
  const { context, skill, profile, request, rehearsal, grants, approvals, approvalWaitMs, pollMs, now } = params

  if (rehearsal) {
    return { decision: { approved: false, stub: true }, outcome: { kind: 'stubbed' } }
  }

  const ceiling = checkVerbCeiling({
    description: request.description,
    label: request.label,
  })

  if (request.drift && grants) {
    const grant = await grants.findActive({
      workspaceId: skill.workspaceId,
      skillId: skill.id,
      profileId: profile.id,
    })
    if (grant) await grants.void(grant.id, request.drift)
  }

  if (!ceiling && !request.drift && grants && approvals) {
    const grant = await grants.findActive({
      workspaceId: skill.workspaceId,
      skillId: skill.id,
      profileId: profile.id,
    })
    if (grant) {
      const use = await grants.recordUse(grant.id)
      if (use.withinBudget && use.withinRate) {
        await approvals.recordAutoApproved({
          workspaceId: skill.workspaceId,
          approverUserId: context.userId,
          sessionId: context.sessionId,
          grantId: grant.id,
          payload: approvalPayload(skill, profile, request, null),
        })
        return {
          decision: { approved: true },
          outcome: { kind: 'auto_approved', grantId: grant.id },
        }
      }
    }
  }

  if (!approvals) {
    return {
      decision: {
        approved: false,
        reason: 'No approvals surface is configured on this deployment, so terminal sends cannot be approved.',
      },
      outcome: { kind: 'denied', reason: 'approvals_unavailable' },
    }
  }

  const { id } = await approvals.createSendApproval({
    workspaceId: skill.workspaceId,
    approverUserId: context.userId,
    sessionId: context.sessionId,
    payload: approvalPayload(skill, profile, request, ceiling?.reason ?? null),
    expiresAt: new Date(now() + approvalWaitMs).toISOString(),
  })
  const deadline = now() + approvalWaitMs
  while (now() < deadline) {
    const status: BlockApprovalStatus | null = await approvals.getStatus(id)
    if (status === 'approved') {
      return { decision: { approved: true }, outcome: { kind: 'approved', approvalId: id } }
    }
    if (status && status !== 'pending') {
      return {
        decision: { approved: false, reason: `send ${status}` },
        outcome: { kind: 'denied', reason: status, approvalId: id },
      }
    }
    await sleep(pollMs)
  }
  await approvals.expire(id).catch(() => {})
  return {
    decision: {
      approved: false,
      reason: 'The send was not approved in time. It is parked in Approvals; approve it (or grant this skill) and run the skill again.',
    },
    outcome: { kind: 'denied', reason: 'timeout', approvalId: id },
  }
}
