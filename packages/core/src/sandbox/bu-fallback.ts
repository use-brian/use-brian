/**
 * The browser-use WATCHED fallback (R2-1/R2-7): `browserExplore` runs an
 * agentic browsing loop for a NOVEL flow — one no logic-block covers yet —
 * inside the cloud micro-VM, and ALWAYS self-heals the run into a draft
 * logic-block (R2-5, v0 distiller). Autonomy lives in the navigation, never
 * in skipping the send: the draft's terminal verbs gate exactly like any
 * block's.
 *
 * Governance edges, held hard:
 *  - CLOUD-ONLY for the agentic loop (R2-7): the local (real-Chrome) backend
 *    never runs an autonomous agent. Unattended + a local-default profile is
 *    an outright refusal; a WATCHED run on a local-default profile also
 *    refuses (the watched cloud run must be an explicit profile/backend
 *    choice, never a silent re-route of an account-sensitive identity to a
 *    datacenter IP).
 *  - Unattended additionally needs Barrier 2 (metering + the flag) AND a
 *    paid plan (R2-8) — same gate as every computer tool.
 */
import { z } from 'zod'
import { buildTool, type Tool, type ToolContext, type ToolResult } from '../tools/types.js'
import { isAutonomousToolContext } from '../tools/capability-gate.js'
import type { Sensitivity } from '../security/sensitivity.js'
import { extractEffectContract } from './effect-contract.js'
import {
  describeProfileResolution,
  resolveProfileForCall,
  type BrowserProfileStore,
} from './profiles.js'
import type { BrowserSkillStore } from './browser-skills.js'
import type { SandboxTaskBinding } from './cloud-browser-provider.js'
import { registrableSiteOf } from './orchestrator.js'
import { distillTrace, skillNameFromGoal } from './self-heal.js'
import type { ResolveComputerToolPolicy } from './tools.js'
import type { SandboxProvider, SessionVault } from './types.js'

export type BuFallbackEvent = {
  type: 'browser_explore'
  site: string
  steps: number
  distilled: boolean
  skillName: string | null
  ok: boolean
}

export type CreateBuFallbackToolOptions = {
  provider: SandboxProvider | null
  binding: SandboxTaskBinding | null
  skills: BrowserSkillStore | null
  profiles?: {
    store: BrowserProfileStore
    vault?: SessionVault | null
    assistantClearance: (context: ToolContext) => Promise<Sensitivity>
  } | null
  resolvePolicy?: ResolveComputerToolPolicy
  unattendedEnabled?: () => boolean
  getWorkspacePlan?: (workspaceId: string) => Promise<string>
  onEvent?: (event: BuFallbackEvent, context: ToolContext) => void
  maxSteps?: number
  timeoutMs?: number
}

const DEFAULT_MAX_STEPS = 40
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000

export function createBuFallbackTool(opts: CreateBuFallbackToolOptions): { browserExplore: Tool } {
  const unattendedEnabled = opts.unattendedEnabled ?? (() => false)

  async function policyGate(context: ToolContext): Promise<ToolResult | null> {
    if (!opts.resolvePolicy) return null
    try {
      const policy = await opts.resolvePolicy('browserExplore', {
        userId: context.userId,
        assistantId: context.assistantId,
      })
      if (policy === 'block') {
        return {
          data: 'ERROR: "browserExplore" is blocked by tool policy for this assistant. A workspace member can change it under Studio > Connectors > Computer.',
          isError: true,
        }
      }
    } catch {
      return null
    }
    return null
  }

  const browserExplore = buildTool({
    name: 'browserExplore',
    description:
      'Explore a NOVEL browsing flow with the watched agentic fallback when no saved browser skill covers it (check listBrowserSkills first). Runs in the cloud browser as a browser profile, and always distills the successful run into a draft browser skill for deterministic reuse. Terminal sends in the draft stay approval-gated. Prefer runBrowserSkill whenever a skill already exists.',
    inputSchema: z.object({
      goal: z.string().min(1).max(2_000).describe('What to accomplish, concretely (site, action, content)'),
      url: z.string().min(1).describe('Absolute http(s) URL to start from'),
      profile: z
        .string()
        .max(120)
        .optional()
        .describe('Browser profile name to explore as (required when several match)'),
      saveAs: z
        .string()
        .max(120)
        .optional()
        .describe('Name for the distilled draft skill (defaults to a goal-derived name)'),
    }),
    isReadOnly: false,
    isConcurrencySafe: false,
    requiresConfirmation: false,
    resolveConfirmation: async (context) => {
      if (!opts.resolvePolicy) return false
      try {
        return (
          (await opts.resolvePolicy('browserExplore', {
            userId: context.userId,
            assistantId: context.assistantId,
          })) === 'ask'
        )
      } catch {
        return false
      }
    },
    timeoutMs: DEFAULT_TIMEOUT_MS + 60_000,
    async execute(input, context) {
      const autonomous = isAutonomousToolContext(context)
      if (autonomous) {
        if (!unattendedEnabled()) {
          return {
            data: 'ERROR: Agentic browsing is unavailable on autonomous runs until unattended computer use is enabled on this deployment.',
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
      }
      const blocked = await policyGate(context)
      if (blocked) return blocked
      if (!context.workspaceId) {
        return { data: 'ERROR: Browser exploration requires a workspace-scoped chat.', isError: true }
      }
      if (!opts.provider || !opts.binding) {
        return {
          data: 'ERROR: The agentic browsing fallback runs in the cloud sandbox, which is not configured on this deployment.',
          isError: true,
        }
      }
      let parsed: URL
      try {
        parsed = new URL(input.url)
      } catch {
        return { data: `ERROR: "${input.url}" is not a valid absolute URL.`, isError: true }
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return { data: 'ERROR: Only http(s) URLs can be explored.', isError: true }
      }
      const site = registrableSiteOf(input.url) ?? parsed.hostname

      // Profile at call time (R2-10) — and the R2-7 cloud-only edge.
      if (!opts.profiles) {
        return {
          data: 'ERROR: Browser profiles are not configured on this deployment, and exploration must run as a profile.',
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
        site,
        profileName: input.profile,
      })
      if (resolution.kind !== 'ok') {
        return { data: `ERROR: ${describeProfileResolution(resolution)}`, isError: true }
      }
      const profile = resolution.profile
      if (profile.defaultBackend === 'local') {
        // R2-7: an autonomous agent is never loose in the user's real
        // browser — and an account-sensitive (local-default) identity is
        // never silently re-routed to a datacenter IP either. Unattended OR
        // watched, this refuses; the human decision to explore this
        // identity from the cloud is flipping the profile's backend.
        return {
          data: autonomous
            ? `ERROR: Unattended agentic browsing never runs on the local browser. The profile "${profile.name}" defaults to the user's own browser; unattended exploration is cloud-only (R2-7).`
            : `ERROR: The profile "${profile.name}" browses in the user's own browser (local), and the agentic fallback runs only in the cloud sandbox. Ask the user to flip the profile's default browser to cloud if they want exploration under this identity.`,
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
          },
          { url: input.url },
        )
        const goal = `Start at ${input.url}. ${input.goal}`
        const { trace, output } = await opts.provider.runBrowserUse(sandboxId, {
          goal,
          maxSteps: opts.maxSteps ?? DEFAULT_MAX_STEPS,
          timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        })

        // Self-heal is ALWAYS automatic (R2-5): distill the watched run into
        // a draft block, immediately usable and gated by default.
        let skillName: string | null = null
        if (trace.length > 0 && opts.skills) {
          const distilled = distillTrace({ trace, goal: input.goal, site })
          const contract = extractEffectContract({ code: distilled.code, site })
          let name = input.saveAs?.trim() || skillNameFromGoal(input.goal, site)
          const existing = await opts.skills.getByName({ workspaceId: context.workspaceId, name })
          if (existing) name = `${name}-${Date.now() % 10_000}`
          const skill = await opts.skills.create({
            workspaceId: context.workspaceId,
            name,
            site,
            description: distilled.description,
            code: distilled.code,
            contract,
            recording: distilled.recording,
            origin: 'self_heal',
            createdBy: context.userId,
          })
          skillName = skill.name
        }

        try {
          opts.onEvent?.(
            {
              type: 'browser_explore',
              site,
              steps: trace.length,
              distilled: skillName !== null,
              skillName,
              ok: true,
            },
            context,
          )
        } catch {
          /* audit must never break the tool */
        }

        const lines = [output || `Explored ${site} (${trace.length} steps).`]
        if (skillName) {
          lines.push(
            `Distilled this run into the draft browser skill "${skillName}" - runBrowserSkill can now replay it deterministically. Its send/submit steps stay approval-gated until the user grants the skill on the profile; rehearse first with rehearsal:true.`,
          )
        }
        return {
          data: lines.join('\n'),
          meta: { site, steps: trace.length, ...(skillName ? { skill: skillName } : {}) },
        }
      } catch (err) {
        try {
          opts.onEvent?.(
            { type: 'browser_explore', site, steps: 0, distilled: false, skillName: null, ok: false },
            context,
          )
        } catch {
          /* ignore */
        }
        return {
          data: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })

  return { browserExplore }
}
