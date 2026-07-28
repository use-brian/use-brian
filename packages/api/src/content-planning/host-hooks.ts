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
import { buildContentPlanningSoul, DRAFT_SESSION_ADDENDUM } from './prompt.js'

export const injectContentPlanningTools: InjectExtraTools = async (
  ctx: ExtraToolContext,
) => {
  if (
    ctx.assistant.kind !== 'app'
    || ctx.assistant.appType !== 'distribution'
    || ctx.session?.mode !== 'draft'
  ) {
    return
  }
  const tool = buildProposeDraftsTool()
  ctx.tools.set(tool.name, tool)
}

export const resolveContentPlanningPrompt = (session: {
  mode: string | null
  channelType: string
}): string | null => session.mode === 'draft' ? DRAFT_SESSION_ADDENDUM : null

export const resolveContentPlanningSoul: ResolveAppSoul = (params) =>
  params.appType === 'distribution'
    ? buildContentPlanningSoul({
        name: params.name,
        workspaceName: params.team?.name,
        workspacePurpose: params.team?.purpose,
        assistantBio: params.assistantBio,
      })
    : null
