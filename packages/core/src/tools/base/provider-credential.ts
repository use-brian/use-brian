import type { ExternalCredentialLease, ExternalCredentialPool } from '@use-brian/agent-runtime/providers/credential-pool.js'

export async function resolveToolCredential(
  pool: ExternalCredentialPool | undefined,
  provider: string,
  systemFallback: string | undefined,
): Promise<ExternalCredentialLease | null> {
  if (pool) return pool.resolve(provider, systemFallback)
  const secret = systemFallback?.trim()
  if (!secret) return null
  return {
    credentialId: null,
    provider,
    secret,
    source: 'system',
    recordSpend: async () => {},
  }
}
export async function recordToolSpend(lease: ExternalCredentialLease, costUsd: number): Promise<void> {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return
  try {
    await lease.recordSpend(costUsd)
  } catch (error) {
    console.error(
      `[provider-credentials] failed to record ${lease.provider} tool spend`,
      error instanceof Error ? error.message : String(error),
    )
  }
}
