/**
 * Mode resolution for inter-assistant calls.
 *
 * Given a (caller, callee) pair, resolves to the AssistantMode bound to the
 * connection between them — or null if the connection has no mode (free).
 *
 * The actual lookups are dependency-injected (see `ModeResolverDeps`) so the
 * core package stays free of a `pg` dependency.
 *
 * [COMP:inter-assistant/mode-resolver]
 */

import type { AssistantMode } from '../a2a/types.js'

export type ModeResolverDeps = {
  /**
   * Look up the mode_id bound to the connection (follower=caller, following=callee).
   * Returns:
   *   - mode_id string when a mode is bound
   *   - null when the connection exists but has no mode (= free)
   *   - undefined when no accepted connection exists (caller can't access)
   */
  getConnectionModeId: (
    callerAssistantId: string,
    calleeAssistantId: string,
  ) => Promise<string | null | undefined>

  /** Fetch a mode by id, including all fields. */
  getMode: (modeId: string) => Promise<AssistantMode | null>
}

export type ModeResolution =
  | { kind: 'no_connection' }
  | { kind: 'free' }
  | { kind: 'mode'; mode: AssistantMode }

/**
 * Resolve the mode (if any) bound to the connection between caller and callee.
 *
 * - `no_connection`: caller has no accepted connection to callee — reject.
 * - `free`: connection exists, no mode bound — full access.
 * - `mode`: connection bound to the returned mode — apply its filters.
 */
export async function resolveMode(
  deps: ModeResolverDeps,
  callerAssistantId: string,
  calleeAssistantId: string,
): Promise<ModeResolution> {
  const modeId = await deps.getConnectionModeId(callerAssistantId, calleeAssistantId)
  if (modeId === undefined) return { kind: 'no_connection' }
  if (modeId === null) return { kind: 'free' }

  const mode = await deps.getMode(modeId)
  if (mode === null) {
    // Mode was deleted between connection.mode_id read and mode lookup —
    // ON DELETE SET NULL on the FK means this races toward 'free' eventually,
    // but the read here saw a stale id. Treat as free (the FK action will
    // reconcile on next read).
    return { kind: 'free' }
  }

  return { kind: 'mode', mode }
}
