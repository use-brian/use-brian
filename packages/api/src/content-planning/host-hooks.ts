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
import { buildProposeDraftsTool } from './draft-tool.js'
import { buildProposePlanTool } from './plan-tool.js'
import {
  buildContentPlanningSoul,
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

export const resolveContentPlanningSoul: ResolveAppSoul = (params) =>
  params.appType === 'distribution'
    ? buildContentPlanningSoul({
        name: params.name,
        workspaceName: params.team?.name,
        workspacePurpose: params.team?.purpose,
        assistantBio: params.assistantBio,
      })
    : null
