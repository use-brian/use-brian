/**
 * The governed logic-block runner + its tool surface (R2-5/R2-9/R2-10).
 *
 * `runBrowserSkill(skill, profile, params)` runs a reviewed block against the
 * selected profile backend. Cloud runs materialize code into the privileged
 * sandbox lane; local runs interpret the stored recording through the local
 * provider. Both paths use THIS host loop for terminal-send governance:
 *
 *   rehearsal        → every send is STUBBED ("would send", never fires)
 *   verb ceiling     → NEVER auto-approvable: queues for a human, grant or not
 *   drift            → any matching grant is VOIDED, the send re-gates async
 *   grant satisfied  → auto-approved + an `auto_approved` AUDIT row
 *   otherwise        → an async `pending_approvals` row (watched or
 *                      unattended alike); the block waits, then fails closed
 *
 * Blocks are site-scoped + identity-agnostic: the PROFILE is chosen at call
 * time (one enabled+cleared match auto-selects, several must be named).
 * Read-only blocks (no terminal sends in the contract) run with zero human
 * touch — the 1984 case. A flagged contract refuses to run at all.
 */
import { z } from 'zod'
import { buildTool, type Tool, type ToolContext, type ToolResult } from '../tools/types.js'
import { isAutonomousToolContext } from '../tools/capability-gate.js'
import type { Sensitivity } from '../security/sensitivity.js'
import {
  contractAllowsRun,
  contractIsReadOnly,
  extractEffectContract,
} from './effect-contract.js'
import {
  canUseProfile,
  describeProfileResolution,
  resolveProfileForCall,
  type BrowserProfile,
  type BrowserProfileStore,
} from './profiles.js'
import {
  type BlockApprovalsPort,
  type BrowserSkill,
  type BrowserSkillGrantStore,
  type BrowserSkillStore,
} from './browser-skills.js'
import type { SandboxTaskBinding } from './cloud-browser-provider.js'
import type { ResolveComputerToolPolicy } from './tools.js'
import {
  BLOCK_MODULE_PATH,
  ENTRY_PATH,
  PARAMS_PATH,
  RESULT_PATH,
  RUNNER_MODULE_PATH,
  buildEntrySource,
  buildRunnerShimSource,
  sendDecisionPath,
  sendRequestPath,
  type BlockRunResult,
  type BlockSendDecision,
  type BlockSendRequest,
} from './runner-shim.js'
import type { BrowserProvider, SandboxProvider, SessionVault } from './types.js'
import { decideTerminalSend, type SendGateOutcome } from './send-gate.js'
import type { LocalTraceStep } from './local-skill-runner.js'
import { distillLocalTrace, runLocalSkill, validateLocalRecording } from './local-skill-runner.js'
import { registrableSiteOf } from './orchestrator.js'

export type SkillRunnerEvent = {
  type: 'skill_run'
  skill: string
  site: string
  rehearsal: boolean
  ok: boolean
  sends: number
  autoApproved: number
  queued: number
  stubbed: number
  denied: number
}

export type { SendGateOutcome } from './send-gate.js'

export type CreateSkillRunnerToolsOptions = {
  provider: SandboxProvider | null
  /** Local provider used when the selected profile defaults to My Browser. */
  local?: BrowserProvider | null
  binding: SandboxTaskBinding | null
  /** The block artifacts (open store over `browser_skills`). */
  skills: BrowserSkillStore | null
  /** Block+profile grants (R2-2; closed impl). Null → every send queues. */
  grants?: BrowserSkillGrantStore | null
  /** The async pending_approvals bridge. Null → sends fail closed. */
  approvals?: BlockApprovalsPort | null
  /** Profile plumbing (same shape as the browse tools'). */
  profiles?: {
    store: BrowserProfileStore
    vault?: SessionVault | null
    assistantClearance: (context: ToolContext) => Promise<Sensitivity>
  } | null
  resolvePolicy?: ResolveComputerToolPolicy
  unattendedEnabled?: () => boolean
  getWorkspacePlan?: (workspaceId: string) => Promise<string>
  onEvent?: (event: SkillRunnerEvent, context: ToolContext) => void
  /** How long an un-granted send waits for its approval before failing closed. */
  approvalWaitMs?: number
  /** Handshake poll interval (tests dial it down). */
  pollMs?: number
  /** Hard cap on one block run. */
  runTimeoutMs?: number
  now?: () => number
  /** Flat browser recording owned by createComputerTools. */
  getSessionTrace?: (sessionId: string) => LocalTraceStep[]
  clearSessionTrace?: (sessionId: string) => void
}

const DEFAULT_APPROVAL_WAIT_MS = 120_000
const DEFAULT_POLL_MS = 400
const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000
const OUTPUT_CAP = 8_000

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function createSkillRunnerTools(opts: CreateSkillRunnerToolsOptions): {
  runBrowserSkill: Tool
  saveBrowserSkill: Tool
  listBrowserSkills: Tool
  listBrowserProfiles: Tool
} {
  const unattendedEnabled = opts.unattendedEnabled ?? (() => false)
  const approvalWaitMs = opts.approvalWaitMs ?? DEFAULT_APPROVAL_WAIT_MS
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const runTimeoutMs = opts.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS
  const now = opts.now ?? Date.now

  async function autonomousGate(context: ToolContext): Promise<ToolResult | null> {
    if (!isAutonomousToolContext(context)) return null
    if (!unattendedEnabled()) {
      return {
        data: 'ERROR: Browser skills are unavailable on autonomous runs until unattended computer use is enabled on this deployment.',
        isError: true,
      }
    }
    const plan = opts.getWorkspacePlan
      ? await opts.getWorkspacePlan(context.workspaceId ?? '').catch(() => 'free')
      : 'free'
    if (plan === 'free') {
      return {
        data: 'ERROR: Unattended computer use is available on paid plans only. The user can upgrade the workspace plan, or run this from chat.',
        isError: true,
      }
    }
    return null
  }

  async function policyGate(toolName: string, context: ToolContext): Promise<ToolResult | null> {
    if (!opts.resolvePolicy) return null
    try {
      const policy = await opts.resolvePolicy(toolName, {
        userId: context.userId,
        assistantId: context.assistantId,
      })
      if (policy === 'block') {
        return {
          data: `ERROR: "${toolName}" is blocked by tool policy for this assistant. A workspace member can change it under Studio > Connectors > Computer.`,
          isError: true,
        }
      }
    } catch {
      return null
    }
    return null
  }

  function policyAsk(toolName: string): (context: ToolContext) => Promise<boolean> {
    return async (context) => {
      if (!opts.resolvePolicy) return false
      try {
        return (
          (await opts.resolvePolicy(toolName, {
            userId: context.userId,
            assistantId: context.assistantId,
          })) === 'ask'
        )
      } catch {
        return false
      }
    }
  }

  async function readScratch(sandboxId: string, path: string): Promise<string | null> {
    try {
      const { bytes } = await opts.provider!.bridge.save(sandboxId, { path })
      return new TextDecoder().decode(bytes)
    } catch {
      return null
    }
  }

  async function writeScratch(sandboxId: string, path: string, text: string): Promise<void> {
    await opts.provider!.bridge.load(sandboxId, { path, bytes: new TextEncoder().encode(text) })
  }

  async function decideSend(params: {
    context: ToolContext
    skill: BrowserSkill
    profile: BrowserProfile
    request: BlockSendRequest
    rehearsal: boolean
  }): Promise<{ decision: BlockSendDecision; outcome: SendGateOutcome }> {
    return decideTerminalSend({
      ...params,
      grants: opts.grants,
      approvals: opts.approvals,
      approvalWaitMs,
      pollMs,
      now,
    })
  }

  /** Materialize + run one block, answering the send handshake as it runs. */
  async function runGovernedBlock(params: {
    context: ToolContext
    sandboxId: string
    skill: BrowserSkill
    profile: BrowserProfile
    input: Record<string, unknown>
    rehearsal: boolean
  }): Promise<{ run: { stdout: string; stderr: string; exitCode: number }; result: BlockRunResult | null; outcomes: SendGateOutcome[] }> {
    const { sandboxId, skill } = params
    await writeScratch(
      sandboxId,
      RUNNER_MODULE_PATH,
      buildRunnerShimSource({
        sendTimeoutSeconds: Math.ceil(approvalWaitMs / 1000) + 60,
        allowedSite: skill.site,
      }),
    )
    await writeScratch(sandboxId, BLOCK_MODULE_PATH, skill.code)
    await writeScratch(sandboxId, ENTRY_PATH, buildEntrySource())
    await writeScratch(sandboxId, PARAMS_PATH, JSON.stringify(params.input ?? {}))

    const handle = await opts.provider!.runSkill(sandboxId, {
      entryPath: ENTRY_PATH,
      timeoutMs: runTimeoutMs,
    })
    let finished = false
    const runPromise = handle.wait().then((res) => {
      finished = true
      return res
    })

    const outcomes: SendGateOutcome[] = []
    let nextSend = 1
    const hardDeadline = now() + runTimeoutMs
    while (!finished && now() < hardDeadline) {
      const requestText = await readScratch(sandboxId, sendRequestPath(nextSend))
      if (requestText) {
        let request: BlockSendRequest
        try {
          request = JSON.parse(requestText) as BlockSendRequest
        } catch {
          request = { n: nextSend }
        }
        const { decision, outcome } = await decideSend({
          context: params.context,
          skill,
          profile: params.profile,
          request,
          rehearsal: params.rehearsal,
        })
        outcomes.push(outcome)
        await writeScratch(sandboxId, sendDecisionPath(nextSend), JSON.stringify(decision))
        nextSend += 1
        continue
      }
      await sleep(pollMs)
    }

    const run = await runPromise
    const resultText = await readScratch(sandboxId, RESULT_PATH)
    let result: BlockRunResult | null = null
    if (resultText) {
      try {
        result = JSON.parse(resultText) as BlockRunResult
      } catch {
        result = null
      }
    }
    return { run, result, outcomes }
  }

  // ── runBrowserSkill ──────────────────────────────────────────

  const runBrowserSkill = buildTool({
    name: 'runBrowserSkill',
    requiresCapability: 'computer',
    description:
      'Run a saved browser skill (a reviewed, deterministic browsing script) against a browser profile. The profile is chosen at call time: if several enabled profiles match you must name one. Terminal send/submit actions inside the skill require approval unless the user granted this skill on this profile; rehearsal:true replays the skill with sends stubbed ("would send", nothing fires). Use listBrowserSkills to see what exists.',
    inputSchema: z.object({
      skill: z.string().min(1).max(120).describe('The saved browser skill name (see listBrowserSkills)'),
      profile: z
        .string()
        .max(120)
        .optional()
        .describe('Browser profile name to run as (required when several profiles match)'),
      params: z.record(z.string(), z.unknown()).optional().describe('Skill parameters (see its params list)'),
      rehearsal: z
        .boolean()
        .optional()
        .describe('Replay with terminal sends stubbed - reports what WOULD be sent, fires nothing'),
    }),
    isReadOnly: false,
    isConcurrencySafe: false,
    requiresConfirmation: false,
    resolveConfirmation: policyAsk('runBrowserSkill'),
    timeoutMs: DEFAULT_RUN_TIMEOUT_MS + 5 * 60 * 1000,
    maxResultSizeChars: OUTPUT_CAP * 2,
    async execute(input, context) {
      const gate =
        (await autonomousGate(context)) ?? (await policyGate('runBrowserSkill', context))
      if (gate) return gate
      if (!context.workspaceId) {
        return { data: 'ERROR: Browser skills require a workspace-scoped chat.', isError: true }
      }
      if (!opts.skills) {
        return { data: 'ERROR: Browser skills are not configured on this deployment.', isError: true }
      }
      const skill = await opts.skills.getByName({
        workspaceId: context.workspaceId,
        name: input.skill,
      })
      if (!skill || skill.status !== 'active') {
        return {
          data: `ERROR: No browser skill named "${input.skill}" exists in this workspace. Use listBrowserSkills to see what is available.`,
          isError: true,
        }
      }
      // Fail-closed contract (R2-5): a flagged block never reaches the runner.
      if (!contractAllowsRun(skill.contract)) {
        return {
          data: `ERROR: The skill "${skill.name}" is flagged by its effect contract (${skill.contract.flagged.join(', ')}) and cannot run until its code is cleaned up to use only the governed runner verbs.`,
          isError: true,
        }
      }

      // Profile at call time (R2-10) — REQUIRED for a block run.
      if (!opts.profiles) {
        return {
          data: 'ERROR: Browser profiles are not configured on this deployment, and a skill must run as a profile.',
          isError: true,
        }
      }
      const resolution = await resolveProfileForCall({
        store: opts.profiles.store,
        vault: opts.profiles.vault,
        actor: {
          userId: context.userId,
          workspaceId: context.workspaceId,
          assistantId: context.assistantId,
          assistantClearance: await opts.profiles.assistantClearance(context),
        },
        site: skill.site,
        profileName: input.profile,
      })
      if (resolution.kind !== 'ok') {
        return { data: `ERROR: ${describeProfileResolution(resolution)}`, isError: true }
      }
      const profile = resolution.profile
      const rehearsal = input.rehearsal === true
      if (profile.defaultBackend === 'local') {
        if (!opts.local) {
          return { data: 'ERROR: The local browser backend is not configured on this deployment.', isError: true }
        }
        try {
          const { result, outcomes } = await runLocalSkill({
            local: opts.local,
            context,
            skill,
            profile,
            rehearsal,
            input: input.params ?? {},
            grants: opts.grants,
            approvals: opts.approvals,
            approvalWaitMs,
            pollMs,
            now,
          })
          const counts = {
            autoApproved: outcomes.filter((o) => o.kind === 'auto_approved').length,
            approved: outcomes.filter((o) => o.kind === 'approved').length,
            stubbed: outcomes.filter((o) => o.kind === 'stubbed').length,
            denied: outcomes.filter((o) => o.kind === 'denied').length,
          }
          try {
            opts.onEvent?.(
              {
                type: 'skill_run',
                skill: skill.name,
                site: skill.site,
                rehearsal,
                ok: result.ok,
                sends: outcomes.length,
                autoApproved: counts.autoApproved,
                queued: counts.approved + counts.denied,
                stubbed: counts.stubbed,
                denied: counts.denied,
              },
              context,
            )
          } catch {
            /* audit must never break the tool */
          }
          const lines = [
            result.ok
              ? `Skill "${skill.name}" ${rehearsal ? 'rehearsed' : 'completed'} locally as profile "${profile.name}".`
              : `Skill "${skill.name}" did not complete locally: ${result.error ?? 'unknown failure'}`,
          ]
          if (result.summary) lines.push(result.summary.slice(0, OUTPUT_CAP))
          if (rehearsal && result.wouldSend?.length) {
            lines.push(
              `Would send (stubbed, nothing fired): ${result.wouldSend
                .map((w) => w.description ?? w.ref ?? 'send')
                .join(' | ')}`,
            )
          }
          if (counts.autoApproved > 0) lines.push(`${counts.autoApproved} send(s) auto-approved by the user's standing grant (audited).`)
          if (counts.approved > 0) lines.push(`${counts.approved} send(s) approved by the user.`)
          if (counts.denied > 0) lines.push(`${counts.denied} send(s) were NOT approved - the skill stopped there.`)
          return {
            data: lines.join('\n'),
            isError: !result.ok,
            meta: { skill: skill.name, profile: profile.name, backend: 'local', rehearsal, sends: outcomes.length },
          }
        } catch (err) {
          return { data: `ERROR: ${err instanceof Error ? err.message : String(err)}`, isError: true }
        }
      }

      if (!opts.provider || !opts.binding) {
        return {
          data: 'ERROR: Browser skills run in the cloud sandbox, which is not configured on this deployment.',
          isError: true,
        }
      }
      try {
        const { sandboxId } = await opts.binding.resolve(
          {
            userId: context.userId,
            workspaceId: context.workspaceId,
            sessionId: context.sessionId,
            profileId: profile.id,
            ...(context.registerInvocationFinalizer
              ? { registerInvocationFinalizer: context.registerInvocationFinalizer }
              : {}),
          },
          { url: `https://${skill.site}/`, browser: true },
        )
        const { run, result, outcomes } = await runGovernedBlock({
          context,
          sandboxId,
          skill,
          profile,
          input: input.params ?? {},
          rehearsal,
        })

        const counts = {
          autoApproved: outcomes.filter((o) => o.kind === 'auto_approved').length,
          approved: outcomes.filter((o) => o.kind === 'approved').length,
          stubbed: outcomes.filter((o) => o.kind === 'stubbed').length,
          denied: outcomes.filter((o) => o.kind === 'denied').length,
        }
        try {
          opts.onEvent?.(
            {
              type: 'skill_run',
              skill: skill.name,
              site: skill.site,
              rehearsal,
              ok: result?.ok ?? run.exitCode === 0,
              sends: outcomes.length,
              autoApproved: counts.autoApproved,
              queued: counts.approved + counts.denied,
              stubbed: counts.stubbed,
              denied: counts.denied,
            },
            context,
          )
        } catch {
          /* audit must never break the tool */
        }

        const lines: string[] = []
        if (result?.ok) {
          lines.push(
            `Skill "${skill.name}" ${rehearsal ? 'rehearsed' : 'completed'} as profile "${profile.name}".`,
          )
          if (result.summary) lines.push(result.summary.slice(0, OUTPUT_CAP))
        } else {
          const reason = result?.error ?? run.stderr.slice(0, 500) ?? 'unknown failure'
          lines.push(`Skill "${skill.name}" did not complete: ${reason.slice(0, OUTPUT_CAP)}`)
        }
        if (rehearsal && result?.wouldSend?.length) {
          lines.push(
            `Would send (stubbed, nothing fired): ${result.wouldSend
              .map((w) => w.description ?? w.ref ?? 'send')
              .join(' | ')}`,
          )
        }
        if (counts.autoApproved > 0) {
          lines.push(`${counts.autoApproved} send(s) auto-approved by the user's standing grant (audited).`)
        }
        if (counts.approved > 0) lines.push(`${counts.approved} send(s) approved by the user.`)
        if (counts.denied > 0) {
          lines.push(
            `${counts.denied} send(s) were NOT approved - the skill stopped there. The approval request stays in the Approvals queue; the user can approve it (or grant this skill on this profile) and you can run the skill again.`,
          )
        }
        return {
          data: lines.join('\n'),
          isError: !(result?.ok ?? run.exitCode === 0),
          meta: { skill: skill.name, profile: profile.name, rehearsal, sends: outcomes.length },
        }
      } catch (err) {
        return {
          data: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })

  // ── saveBrowserSkill ─────────────────────────────────────────

  const saveBrowserSkill = buildTool({
    name: 'saveBrowserSkill',
    requiresCapability: 'computer',
    description:
      'Save the recent browser actions from this chat as a reusable deterministic browser skill. Use after completing a flow in My Browser; the saved skill can replay locally without asking the model to snapshot every step.',
    inputSchema: z.object({
      name: z.string().min(1).max(120).describe('Name for the reusable browser skill'),
      description: z.string().max(500).optional().describe('What this skill accomplishes'),
      site: z.string().max(253).optional().describe('Registrable site, inferred from the first recorded URL when omitted'),
      parameters: z
        .record(z.string(), z.string())
        .optional()
        .describe('Optional parameter name to recorded fill value mapping, e.g. {query: "the value typed during recording"}'),
    }),
    isReadOnly: false,
    isConcurrencySafe: false,
    requiresConfirmation: false,
    resolveConfirmation: policyAsk('saveBrowserSkill'),
    timeoutMs: 20_000,
    async execute(input, context) {
      const gate = (await autonomousGate(context)) ?? (await policyGate('saveBrowserSkill', context))
      if (gate) return gate
      if (!context.workspaceId) return { data: 'ERROR: Browser skills require a workspace-scoped chat.', isError: true }
      if (!opts.skills) return { data: 'ERROR: Browser skills are not configured on this deployment.', isError: true }
      if (!opts.getSessionTrace) return { data: 'ERROR: Browser recording is not configured on this deployment.', isError: true }

      const trace = opts.getSessionTrace(context.sessionId)
      if (trace.length === 0) {
        return { data: 'ERROR: No browser actions are recorded in this chat yet. Complete a browser flow first.', isError: true }
      }
      const firstUrl = trace.find((step) => step.action === 'open')?.url
      const site = input.site?.trim() || (firstUrl ? registrableSiteOf(firstUrl) : null)
      if (!site) return { data: 'ERROR: The recording has no navigated site. Provide the site explicitly.', isError: true }
      const recordedSites = new Set(
        trace
          .filter((step) => step.action === 'open')
          .map((step) => step.url ? registrableSiteOf(step.url) : null),
      )
      if (recordedSites.size !== 1 || !recordedSites.has(site)) {
        return {
          data: `ERROR: Every recorded navigation must stay on the declared site ${site}.`,
          isError: true,
        }
      }
      if (await opts.skills.getByName({ workspaceId: context.workspaceId, name: input.name })) {
        return { data: `ERROR: A browser skill named "${input.name}" already exists. Choose another name.`, isError: true }
      }

      const distilled = distillLocalTrace({ trace, goal: input.description, parameters: input.parameters })
      const contract = extractEffectContract({ code: distilled.code, site })
      const recordingError = validateLocalRecording({
        site,
        code: distilled.code,
        recording: distilled.recording,
        contract,
      })
      if (recordingError) return { data: `ERROR: ${recordingError}`, isError: true }
      const skill = await opts.skills.create({
        workspaceId: context.workspaceId,
        name: input.name,
        site,
        description: input.description ?? distilled.description,
        code: distilled.code,
        paramsSchema: distilled.paramsSchema,
        contract,
        recording: distilled.recording,
        origin: 'assistant',
        createdBy: context.userId,
      })
      opts.clearSessionTrace?.(context.sessionId)
      return {
        data: `Saved browser skill "${skill.name}" for ${site}. It can now be replayed with runBrowserSkill; terminal submits remain approval-gated.`,
        meta: { skill: skill.name, site, steps: skill.recording.length },
      }
    },
  })

  // ── listBrowserSkills ────────────────────────────────────────

  const listBrowserSkills = buildTool({
    name: 'listBrowserSkills',
    requiresCapability: 'computer',
    description:
      'List the saved browser skills in this workspace: deterministic browsing scripts runBrowserSkill can execute against a browser profile. Shows each skill\'s site, parameters, and whether it performs terminal sends (which need approval or a grant).',
    inputSchema: z.object({
      site: z.string().max(253).optional().describe('Filter by registrable domain (e.g. instagram.com)'),
    }),
    isReadOnly: true,
    isConcurrencySafe: true,
    requiresConfirmation: false,
    resolveConfirmation: policyAsk('listBrowserSkills'),
    timeoutMs: 20_000,
    async execute(input, context) {
      if (!context.workspaceId) {
        return { data: 'ERROR: Browser skills require a workspace-scoped chat.', isError: true }
      }
      if (!opts.skills) {
        return { data: 'ERROR: Browser skills are not configured on this deployment.', isError: true }
      }
      const blocked = await policyGate('listBrowserSkills', context)
      if (blocked) return blocked
      const skills = await opts.skills.list({ workspaceId: context.workspaceId, site: input.site })
      const active = skills.filter((s) => s.status === 'active')
      if (active.length === 0) {
        return { data: 'No browser skills saved in this workspace yet.' }
      }
      const lines = active.map((s) => {
        const sends = contractIsReadOnly(s.contract)
          ? 'read-only'
          : `${s.contract.terminalSends.length} send(s), approval-gated`
        const params = s.contract.params.length ? ` params: ${s.contract.params.join(', ')}` : ''
        const flagged = s.contract.flagged.length ? ' [FLAGGED - cannot run]' : ''
        return `- ${s.name} (${s.site}, v${s.version}, ${sends})${params}${flagged}${s.description ? ` - ${s.description}` : ''}`
      })
      return { data: `Browser skills:\n${lines.join('\n')}` }
    },
  })

  // ── listBrowserProfiles ──────────────────────────────────────

  const listBrowserProfiles = buildTool({
    name: 'listBrowserProfiles',
    requiresCapability: 'computer',
    description:
      'List this workspace\'s browser profiles (saved LOGIN identities for signed-in browsing) and which of them you can browse as. Pass a profile name to browserNavigate or runBrowserSkill when several match. Browsing public sites needs no profile at all — do not call this before an ordinary browse.',
    inputSchema: z.object({}),
    isReadOnly: true,
    isConcurrencySafe: true,
    requiresConfirmation: false,
    resolveConfirmation: policyAsk('listBrowserProfiles'),
    timeoutMs: 20_000,
    async execute(_input, context) {
      if (!context.workspaceId) {
        return { data: 'ERROR: Browser profiles require a workspace-scoped chat.', isError: true }
      }
      if (!opts.profiles) {
        return { data: 'ERROR: Browser profiles are not configured on this deployment.', isError: true }
      }
      const blocked = await policyGate('listBrowserProfiles', context)
      if (blocked) return blocked
      const clearance = await opts.profiles.assistantClearance(context)
      const profiles = await opts.profiles.store.list({ workspaceId: context.workspaceId })
      if (profiles.length === 0) {
        // The 2026-07-15 refusal echoed this line verbatim — it must never
        // read as "browsing is unavailable". Profiles only add saved logins.
        return {
          data:
            'No browser profiles exist in this workspace. That does NOT block browsing: public sites work without one (browserNavigate / browserExplore run identity-less) — proceed with the browse. A profile is only needed for signed-in tasks or running a saved browser skill; the user can create one under Settings > Browser profiles.',
        }
      }
      const lines: string[] = []
      for (const profile of profiles) {
        const gate = canUseProfile(profile, {
          userId: context.userId,
          workspaceId: context.workspaceId,
          assistantId: context.assistantId,
          assistantClearance: clearance,
        })
        let sites = ''
        if (opts.profiles.vault) {
          try {
            const sessions = await opts.profiles.vault.list({ profileId: profile.id })
            const activeSites = sessions.filter((s) => s.status === 'active').map((s) => s.site)
            if (activeSites.length) sites = ` signed into: ${activeSites.join(', ')}`
          } catch {
            /* sites are a nicety */
          }
        }
        lines.push(
          `- ${profile.name} (${profile.defaultBackend} browser${sites}) ${gate.ok ? '[usable]' : `[not usable: ${gate.reason}]`}`,
        )
      }
      return { data: `Browser profiles:\n${lines.join('\n')}` }
    },
  })

  return { runBrowserSkill, saveBrowserSkill, listBrowserSkills, listBrowserProfiles }
}
