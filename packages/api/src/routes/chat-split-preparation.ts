import { isExplicitMeteredModelSelection, isStandardTier, resolveModel } from '../model-resolution.js'

/** Only the legacy Standard splitter has an invariant route before budget/model
 * resolution. Pro/Max, metered, custom, doc and research paths stay at their
 * existing late boundary. A budget block still prevents all reply/worker effects.
 */
export function canPrepareStandardSplit(input: {
  message: string | undefined
  requestedModel: string | undefined
  userPlan: string
  researchMode: boolean
  operateSiteIntent: boolean
  assistantKind: string
  docSurface: boolean
}): boolean {
  return !!input.message && input.message.length > 40
    && !input.researchMode && !input.operateSiteIntent
    && input.assistantKind === 'primary' && !input.docSurface
    && !input.requestedModel?.startsWith('custom:')
    && !isExplicitMeteredModelSelection(input.requestedModel)
    && isStandardTier(resolveModel(input.requestedModel, input.userPlan, 'ok'))
    && isStandardTier(resolveModel(input.requestedModel, input.userPlan, 'downgraded'))
}

/** Classifier work has no worker/publication effects. Join every sibling even
 * after a refusal, so no losing branch can outlive this admitted phase.
 */
export async function settleChatAssessments<R, T, S>(
  research: () => Promise<R>, topic: () => Promise<T>, split: () => Promise<S>,
  recordCompletedSplit?: (result: S) => Promise<void>,
): Promise<[PromiseSettledResult<R>, PromiseSettledResult<T>, PromiseSettledResult<S>]> {
  const results = await Promise.allSettled([
    Promise.resolve().then(research), Promise.resolve().then(topic), Promise.resolve().then(split),
  ])
  // Usage is data, not permission. Record completed speculative work once even
  // when a sibling refuses and the caller will discard its decision.
  if (results[2].status === 'fulfilled' && results[2].value !== undefined) {
    await recordCompletedSplit?.(results[2].value)
  }
  return results
}
