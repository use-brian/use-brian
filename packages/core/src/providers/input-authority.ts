/** Host-only model dispatch admission. [COMP:engine/model-input-authority] */
import type { LLMProvider, Message } from './types.js'

type InputPreparation = { model: string; messages: readonly Message[]; allowProviderFallback?: boolean }
const admissionOwners = new WeakMap<LLMProvider, {
  stream: LLMProvider['stream']; createSession: LLMProvider['createSession'];
  qualifies?: (input: InputPreparation) => boolean;
}>()

/** Internal factory contract: local construction and fresh admission before
 * physical dispatch, or before forwarding to an unregistered implementation. */
export function registerInputAdmissionOwner(provider: LLMProvider,
  qualifies?: (input: InputPreparation) => boolean): LLMProvider {
  admissionOwners.set(provider, { stream: provider.stream, createSession: provider.createSession, qualifies })
  return provider
}

export function ownsInputAdmission(provider: LLMProvider, input: InputPreparation): boolean {
  const owner = admissionOwners.get(provider)
  return !!owner && owner.stream === provider.stream && owner.createSession === provider.createSession
    && (!owner.qualifies || owner.qualifies(input))
}

/** Pin the exact implementation before an await. Checking ownership and then
 * rereading a mutable provider method could dispatch an unchecked replacement. */
export function captureInputAdmissionProvider(provider: LLMProvider): LLMProvider {
  const stream = provider.stream, createSession = provider.createSession
  const captured: LLMProvider = {
    name: provider.name, models: provider.models,
    toolSchemaMode: provider.toolSchemaMode?.bind(provider) ?? (() => 'eager'),
    stream: stream.bind(provider), createSession: createSession.bind(provider),
  }
  const owner = admissionOwners.get(provider)
  return owner && owner.stream === stream && owner.createSession === createSession
    ? registerInputAdmissionOwner(captured, owner.qualifies) : captured
}

/** No allow is retained. Registered children run the unchanged callback at
 * their dispatch boundary; unknown children keep the conservative preflight. */
export async function assertProviderInputPreparation(provider: LLMProvider, input: InputPreparation,
  check?: () => Promise<void>): Promise<void> {
  if (!ownsInputAdmission(provider, input)) await assertInputAuthority(check)
}

/** SDKs may wrap a refusal; its authority classification must survive recovery. */
export function isInputAuthorityError(error: unknown): boolean {
  const seen = new Set<object>()
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error)
    if ((error as { reason?: unknown }).reason === 'authority_changed') return true
    error = (error as { cause?: unknown }).cause
  }
  return false
}

/** The callback is supplied by trusted host code, never public request data. */
export async function assertInputAuthority(check?: () => Promise<void>): Promise<void> {
  if (!check) return
  try { await check() }
  catch (error) {
    if (isInputAuthorityError(error)) throw error
    throw Object.assign(new Error('The model context is unavailable.', { cause: error }), {
      reason: 'authority_changed' as const,retrySafe: false,
    })
  }
}
