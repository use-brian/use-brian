import { counter, nativeGuard } from './native-strict.js'
import { bracketFor, modelRates } from '@use-brian/shared/model-registry'
/**
 * Open runtime seam for a hosted deployment to select provider credentials.
 * The open edition supplies no pool and keeps using its environment values.
 */
import { calculateCost } from '../billing/cost-tracker.js'
import type {
  LLMProvider,
  ProviderRequest,
  ProviderSession,
  SessionOptions,
  StreamChunk,
} from './types.js'

export type ExternalCredentialLease = {
  credentialId: string | null
  provider: string
  secret: string
  source: 'managed' | 'system'
  recordSpend(costUsd: number): Promise<void>
}
export type ExternalCredentialPool = {
  resolve(provider: string, systemFallback?: string): Promise<ExternalCredentialLease | null>
}

/** Credential spend only, not a durable native billing receipt. Unknown evidence
 * stays unknown: never use legacy fallback rates or adapter cost overrides. */
function nativeCredentialCost(metadata: Extract<StreamChunk, { type: 'message_end' }>['nativeMetadata']): number | null {
  if (!metadata || typeof metadata.actualModel !== 'string' || !metadata.usage) return null
  const rates = modelRates(metadata.actualModel)
  if (!rates) return null
  const { inputTokens, outputTokens } = metadata.usage
  const cacheReadTokens = metadata.usage.cacheReadTokens === undefined ? 0 : metadata.usage.cacheReadTokens
  const cacheWriteTokens = metadata.usage.cacheWriteTokens === undefined ? 0 : metadata.usage.cacheWriteTokens
  if (!counter(inputTokens) || !counter(outputTokens) || !counter(cacheReadTokens) || !counter(cacheWriteTokens)) return null
  const promptTokens = inputTokens + cacheReadTokens
  if (!counter(promptTokens)) return null
  const bracket = bracketFor(rates, promptTokens)
  if (!bracket || ![bracket.inPerMTok, bracket.outPerMTok, rates.cacheReadPerMTok, rates.cacheWritePerMTok]
    .every(rate => Number.isFinite(rate) && rate >= 0)) return null
  // Compute from whitelisted counters only; calculatedCostUsd is intentionally ignored.
  const cost = (inputTokens / 1_000_000) * bracket.inPerMTok
    + (outputTokens / 1_000_000) * bracket.outPerMTok
    + (cacheReadTokens / 1_000_000) * rates.cacheReadPerMTok
    + (cacheWriteTokens / 1_000_000) * rates.cacheWritePerMTok
  return Number.isFinite(cost) && cost >= 0 ? cost : null
}

async function recordLeaseSpend(
  lease: ExternalCredentialLease,
  model: string,
  chunk: Extract<StreamChunk, { type: 'message_end' }>,
): Promise<void> {
  const cost = calculateCost(model, chunk.usage)
  if (cost <= 0) return
  try {
    await lease.recordSpend(cost)
  } catch (error) {
    console.error(
      `[provider-credentials] failed to record ${lease.provider} spend`,
      error instanceof Error ? error.message : String(error),
    )
  }
}

async function* meteredStream(
  stream: AsyncIterable<StreamChunk>,
  lease: ExternalCredentialLease,
  requestedModel: string,
): AsyncIterable<StreamChunk> {
  let model = requestedModel
  for await (const chunk of stream) {
    if (chunk.type === 'message_start') model = chunk.model
    if (chunk.type === 'message_end') await recordLeaseSpend(lease, model, chunk)
    yield chunk
  }
}

/**
 * Resolve one credential at every provider call and construct the concrete
 * adapter only after selection. A stateful session keeps its first lease for
 * the session's lifetime so provider-local history and signatures remain
 * coherent across tool rounds.
 */
export function wrapCredentialPoolProvider(options: {
  providerId: string
  pool: ExternalCredentialPool
  systemFallback?: string
  create(secret: string): LLMProvider
}): LLMProvider {
  const template = options.create(options.systemFallback ?? '')

  async function resolveProvider(): Promise<{ lease: ExternalCredentialLease; provider: LLMProvider }> {
    const lease = await options.pool.resolve(options.providerId, options.systemFallback)
    if (!lease) {
      throw new Error(`[provider-credentials] no eligible credential for ${options.providerId}`)
    }
    return { lease, provider: options.create(lease.secret) }
  }

  return {
    name: template.name,
    models: template.models,

    async *stream(request: ProviderRequest): AsyncIterable<StreamChunk> {
      if (request.nativeStrict) {
        yield* nativeGuard((async function* () {
          const resolved = await resolveProvider()
          // Never meter synthetic message_start/usage in the strict lane.
          for await (const chunk of resolved.provider.stream(request)) {
            if (chunk.type === 'message_end') {
              const cost = nativeCredentialCost(chunk.nativeMetadata)
              if (cost !== null && cost > 0) {
                try { await resolved.lease.recordSpend(cost) }
                catch { console.error('native_credential_accounting_failure') }
              }
            }
            yield chunk
          }
        })())
        return
      }
      const resolved = await resolveProvider()
      yield* meteredStream(resolved.provider.stream(request), resolved.lease, request.model)
    },

    createSession(sessionOptions: SessionOptions): ProviderSession {
      let resolved: { lease: ExternalCredentialLease; session: ProviderSession } | null = null
      return {
        async *send(messages, sendOptions): AsyncIterable<StreamChunk> {
          if (!resolved) {
            const selected = await resolveProvider()
            resolved = {
              lease: selected.lease,
              session: selected.provider.createSession(sessionOptions),
            }
          }
          yield* meteredStream(
            resolved.session.send(messages, sendOptions),
            resolved.lease,
            sessionOptions.model,
          )
        },
      }
    },
  }
}
