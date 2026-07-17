/**
 * Bring-your-own storage — staleness garbage collection (GCS and S3).
 *
 * Disconnecting BYO storage drops the customer key entirely (zero standing
 * access), but KEEPS the `workspace_files` index rows so a reconnect (which
 * re-supplies the key) revives them. While disconnected those files are
 * dormant — listed but unreadable (we no longer hold the key).
 *
 * This sweep, run on the scheduled maintenance cadence (alongside memory
 * consolidation), reclaims a binding once it has been disconnected past the
 * grace window with no reconnect: it retracts the dormant `workspace_files`
 * rows whose bytes lived in that bucket (so the brain stops surfacing dead
 * references) and marks the binding swept. The bucket is read from the
 * binding's `config` (non-secret) since the key is already gone. Both storage
 * backends (`gcs` and `s3`) share the identical config shape, so one sweep
 * handles both.
 *
 * See docs/architecture/features/files.md → "Bring-your-own storage",
 * docs/plans/byo-google-storage.md, and docs/plans/byo-s3-storage.md.
 */

import type { ConnectorInstanceStore } from '../db/connector-instance-store.js'
import type { WorkspaceFilesStore } from '@use-brian/core'

/** Grace window after disconnect before a binding's dormant data is reclaimed. */
export const BYO_DISCONNECT_GRACE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export const BYO_STALE_RETRACT_REASON = 'byo_storage_stale'

export type ByoStalenessSweepDeps = {
  connectorInstanceStore: Pick<
    ConnectorInstanceStore,
    'listByProviderSystem' | 'updateCredentialsSystem' | 'setConfigSystem'
  >
  workspaceFilesStore: Pick<WorkspaceFilesStore, 'retractByStorageBucketSystem'>
  /** Current time in ms (injected for testability). */
  nowMs: number
  /** Override the grace window (tests). */
  graceMs?: number
  log?: (msg: string) => void
}

export type ByoStalenessSweepResult = {
  /** Disconnected, not-yet-swept gcs/s3 bindings with a parseable `disconnectedAt`. */
  scanned: number
  /** Bindings reclaimed this run (past grace). */
  swept: number
  /** Total dormant file rows retracted. */
  retractedFiles: number
}

/** BYO storage backends whose disconnected bindings this sweep reclaims. */
const OFFICIAL_BYO_STORAGE_PROVIDERS = ['gcs', 's3'] as const

export async function sweepStaleByoBindings(deps: ByoStalenessSweepDeps): Promise<ByoStalenessSweepResult> {
  const grace = deps.graceMs ?? BYO_DISCONNECT_GRACE_MS
  const instances = (
    await Promise.all(OFFICIAL_BYO_STORAGE_PROVIDERS.map((p) => deps.connectorInstanceStore.listByProviderSystem(p)))
  ).flat()
  const result: ByoStalenessSweepResult = { scanned: 0, swept: 0, retractedFiles: 0 }

  for (const inst of instances) {
    if (inst.connected) continue // live bindings are never stale
    const cfg = (inst.config as Record<string, unknown> | undefined) ?? {}
    if (cfg.staleSwept === true) continue // already reclaimed
    const disconnectedAtRaw = cfg.disconnectedAt
    if (typeof disconnectedAtRaw !== 'string') continue // no disconnect marker (legacy / never disconnected)
    const disconnectedAt = Date.parse(disconnectedAtRaw)
    if (Number.isNaN(disconnectedAt)) continue
    result.scanned++
    if (deps.nowMs - disconnectedAt < grace) continue // still within grace — a reconnect can still revive it

    const bucket = typeof cfg.bucket === 'string' ? cfg.bucket : undefined

    // Defensive: the key is wiped at disconnect, but a binding flipped offline
    // through a generic path may still carry one. Ensure no key survives.
    await deps.connectorInstanceStore.updateCredentialsSystem(inst.id, { type: 'none' })

    if (bucket && inst.workspaceId) {
      const n = await deps.workspaceFilesStore.retractByStorageBucketSystem(
        inst.workspaceId,
        bucket,
        inst.provider === 's3' ? 's3' : 'gs',
        BYO_STALE_RETRACT_REASON,
      )
      result.retractedFiles += n
      deps.log?.(`[byo-staleness] reclaimed stale ${inst.provider} binding ${inst.id} (ws ${inst.workspaceId}); retracted ${n} file(s)`)
    } else {
      deps.log?.(`[byo-staleness] reclaimed stale ${inst.provider} binding ${inst.id} (no bucket/workspace to retract)`)
    }

    // Mark swept so subsequent runs skip it (idempotent reclaim).
    await deps.connectorInstanceStore.setConfigSystem(inst.id, { staleSwept: true })
    result.swept++
  }

  return result
}
