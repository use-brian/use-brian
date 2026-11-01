import { registerInputAdmissionOwner, assertProviderInputPreparation, captureInputAdmissionProvider } from './input-authority.js'
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
    return { lease, provider: captureInputAdmissionProvider(options.create(lease.secret)) }
  }

  return registerInputAdmissionOwner({
    name: template.name,
    models: template.models,

    async *stream(request: ProviderRequest): AsyncIterable<StreamChunk> {
      const resolved = await resolveProvider()
      await assertProviderInputPreparation(resolved.provider, request, request.assertInputAuthority)
      yield* meteredStream(resolved.provider.stream(request), resolved.lease, request.model)
    },

    createSession(sessionOptions: SessionOptions): ProviderSession {
      let resolved: { lease: ExternalCredentialLease; provider: LLMProvider; session?: ProviderSession } | null = null
      return {
        async *send(messages, sendOptions): AsyncIterable<StreamChunk> {
          if (!resolved) {
            const selected = await resolveProvider()
            resolved = {
              lease: selected.lease,
              provider: selected.provider,
            }
          }
          await assertProviderInputPreparation(resolved.provider, { ...sessionOptions, messages }, sendOptions?.assertInputAuthority ?? sessionOptions.assertInputAuthority)
          resolved.session ??= resolved.provider.createSession(sessionOptions)
          yield* meteredStream(
            resolved.session.send(messages, sendOptions),
            resolved.lease,
            sessionOptions.model,
          )
        },
      }
    },
  })
}
