/**
 * Hosted overlay seams with open defaults (extra tools, system prompts, app soul, draft titles).
 *
 * Boot register module registerOverlaySeams: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`OverlaySeamsScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import {
  injectContentPlanningTools, buildContentPlanningPromptResolver, resolveContentPlanningPrompt,
  resolveContentPlanningSoul,
} from '../content-planning/host-hooks.js'
import { resolveJapaneseTeacherSoul } from '../learn-japanese/prompt.js'
import { isDefaultContentDraftTitle, getContentDraftTitlePrefix } from '../db/content-planning-store.js'
import type { InjectExtraTools, ResolveAppSoul } from '../tool-injection-port.js'
import type { OverlaySeamsScope } from './scope.js'

export function registerOverlaySeams(scope: OverlaySeamsScope) {
  const { ports } = scope
  // Content planning is open-core. Hosted hooks layer provider tools and
  // delivery behavior on top; they never replace the draft cardboard tool.
  const injectExtraTools: InjectExtraTools = async (ctx) => {
    await injectContentPlanningTools(ctx)
    await ports.injectExtraTools?.(ctx)
  }
  // The open half is data-backed: plan-mode sessions get the live preset
  // block (current month brief + open ideas) under the static addendum
  // (feed-plan-chat-first.md §6). The hosted port stays sync and narrow.
  const resolveOpenPlanningPrompt = buildContentPlanningPromptResolver()
  const resolveExtraSystemPrompt = async (session: {
    mode: string | null
    channelType: string
    anchor: string
    assistantId?: string
  }): Promise<string | null> => {
    const open = await resolveOpenPlanningPrompt(session)
    const openStatic = resolveContentPlanningPrompt(session)
    const hosted = ports.resolveExtraSystemPrompt?.(session) ?? null
    if (!open) return hosted
    // A hosted override equal to the static open addendum is the same
    // fragment, not an addition — keep the data-backed open version.
    if (!hosted || hosted === open || hosted === openStatic) return open
    return `${open}\n\n${hosted}`
  }
  const resolveAppSoul: ResolveAppSoul = (params) =>
    ports.resolveAppSoul?.(params)
    ?? resolveJapaneseTeacherSoul(params)
    ?? resolveContentPlanningSoul(params)
  const isPlaceholderTitle =
    ports.isPlaceholderTitle ?? isDefaultContentDraftTitle
  const getTitleChannelPrefix =
    ports.getTitleChannelPrefix ?? getContentDraftTitlePrefix

  return {
    injectExtraTools, resolveAppSoul, isPlaceholderTitle, getTitleChannelPrefix, resolveExtraSystemPrompt,
  } as const
}
