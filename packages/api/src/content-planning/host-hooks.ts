/**
 * Open content-planning hooks composed with optional hosted integration hooks
 * by bootOpenApi.
 *
 * [COMP:feed/content-planning-hooks]
 */

import type {
  ExtraToolContext,
  InjectExtraTools,
  ResolveAppSoul,
} from '../tool-injection-port.js'
import {
  createContentIdeasStore,
  type ContentIdeasStore,
} from '../db/content-ideas-store.js'
import {
  createContentPlanStore,
  type ContentPlanStore,
} from '../db/content-plan-store.js'
import { buildProposeDraftsTool } from './draft-tool.js'
import { buildProposePlanTool } from './plan-tool.js'
import {
  buildContentPlanningSoul,
  buildPlanSessionContext,
  DRAFT_SESSION_ADDENDUM,
  PLAN_SESSION_ADDENDUM,
} from './prompt.js'

export const injectContentPlanningTools: InjectExtraTools = async (
  ctx: ExtraToolContext,
) => {
  if (
    ctx.assistant.kind !== 'app'
    || ctx.assistant.appType !== 'distribution'
  ) {
    return
  }
  // One cardboard tool per session mode: drafts refine one post, plans lay
  // out a month. Injecting only the matching one keeps the tool-awareness
  // rule intact - a plan session never sees a tool it has no cardboard for.
  const tool =
    ctx.session?.mode === 'draft'
      ? buildProposeDraftsTool()
      : ctx.session?.mode === 'plan'
        ? buildProposePlanTool()
        : null
  if (!tool) return
  ctx.tools.set(tool.name, tool)
}

export const resolveContentPlanningPrompt = (session: {
  mode: string | null
  channelType: string
}): string | null =>
  session.mode === 'draft'
    ? DRAFT_SESSION_ADDENDUM
    : session.mode === 'plan'
      ? PLAN_SESSION_ADDENDUM
      : null

/** How much backlog a plan turn carries. Titles only, so the cap is cheap. */
const PLAN_CONTEXT_IDEAS_CAP = 15

/**
 * Data-backed planning prompt (docs/plans/feed-plan-chat-first.md §6): the
 * static addendum plus, for `mode='plan'`, a live preset block — the current
 * month's brief/cadence and the open ideas backlog — so the P10 clarify
 * contract has real presets to reconcile against. Degrades to the static
 * addendum on any fetch failure (a broken preset read must never block the
 * turn), and the failure is logged rather than silently swallowed.
 */
export function buildContentPlanningPromptResolver(deps?: {
  planStore?: ContentPlanStore
  ideasStore?: ContentIdeasStore
  /** Injectable clock for tests; production uses the wall clock. */
  now?: () => Date
}): (session: {
  mode: string | null
  channelType: string
  assistantId?: string
}) => Promise<string | null> {
  const planStore = deps?.planStore ?? createContentPlanStore()
  const ideasStore = deps?.ideasStore ?? createContentIdeasStore()
  const now = deps?.now ?? (() => new Date())
  return async (session) => {
    const base = resolveContentPlanningPrompt(session)
    if (!base || session.mode !== 'plan' || !session.assistantId) return base
    try {
      const date = now()
      const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      const [brief, openIdeas] = await Promise.all([
        planStore.getBrief(session.assistantId, month),
        ideasStore.listIdeas({
          assistantId: session.assistantId,
          status: 'open',
        }),
      ])
      const context = buildPlanSessionContext({
        month,
        brief,
        openIdeas: openIdeas.slice(0, PLAN_CONTEXT_IDEAS_CAP),
      })
      return `${base}\n\n${context}`
    } catch (error) {
      console.warn('[content-planning] plan context fetch failed:', error)
      return base
    }
  }
}

export const resolveContentPlanningSoul: ResolveAppSoul = (params) =>
  params.appType === 'distribution'
    ? buildContentPlanningSoul({
        name: params.name,
        workspaceName: params.team?.name,
        workspacePurpose: params.team?.purpose,
        assistantBio: params.assistantBio,
      })
    : null
