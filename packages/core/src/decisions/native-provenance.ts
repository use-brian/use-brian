import { z } from 'zod'
import { registryRowForPricing } from '@use-brian/shared/model-registry'
import { NativeModelIdSchema } from '../computer-use/trace.js'
import type { DecisionNativeMetadata, DecisionResponse } from './types.js'

const counter = z.number().int().nonnegative().safe()
const metadata = z.object({ actualModel: NativeModelIdSchema.nullable(),
  usage: z.object({ inputTokens: counter, outputTokens: counter }).nullable(),
}).strict()

/** Never infer provenance from the legacy response's configured model or usage. */
export function nativeDecisionMetadata(value: unknown): DecisionNativeMetadata {
  const parsed = metadata.safeParse(value)
  return parsed.success ? parsed.data : { actualModel: null, usage: null }
}

export function nativeDecisionResponse(response: DecisionResponse): DecisionResponse {
  const evidence = nativeDecisionMetadata(response.nativeMetadata)
  const actual = evidence.actualModel
  return { ...response, nativeMetadata: evidence,
    model: { catalogId: actual ? registryRowForPricing(actual)?.alias ?? actual : 'unknown', wireId: actual ?? 'unknown' },
    usage: evidence.usage ?? undefined }
}
