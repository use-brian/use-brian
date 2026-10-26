/** Host-only model dispatch admission. [COMP:engine/model-input-authority] */

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
