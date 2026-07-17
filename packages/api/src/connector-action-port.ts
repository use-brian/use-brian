/**
 * Connector-action audit PORT — the seam over the closed emission primitive.
 *
 * The real impl (`db/connector-action-emit.ts`) is closed: it imports the
 * payload classifier (`safety/payload-classifier.ts`) and env. So the OPEN
 * MCP-injection layer must not import it directly. This module owns the shared
 * data TYPES plus a `ConnectorActionAudit` object that carries bound
 * `emit`/`preflight` methods, so an open caller invokes the audit through the
 * methods without importing the closed impl. The composition root injects a
 * `buildConnectorActionAudit` factory that binds the real impl; the open build
 * leaves it unset and connector actions run un-audited. See oss §12.5.
 */

import type { Sensitivity, SensitivityAccumulator } from '@use-brian/core'
import type { ConnectorActionStore, ConnectorActionStatus } from './db/connector-actions-store.js'
import type { DbEpisodesStore } from './db/episodes-store.js'

/**
 * Cross-connector audit deps. Set per-turn at the inject site; carries the
 * workspace + clearance + per-turn sensitivity accumulator + stores needed to
 * emit a `connector_action` Episode + audit row.
 */
export type ConnectorActionAuditDeps = {
  workspaceId: string
  assistantClearance: Sensitivity
  /**
   * Per-turn `SensitivityAccumulator` populated by retrieval / memory reads
   * during the queryLoop. When absent, the IFC `retrieval_max` defaults to
   * `'public'` (conservative — most restrictive ceiling).
   */
  sensitivityAccumulator: SensitivityAccumulator | undefined
  connectorActionStore: ConnectorActionStore
  episodesStore: DbEpisodesStore
}

export type ConnectorActionEmitParams = {
  /** `'threads' | 'twitter' | 'gmail' | 'slack' | 'gcal' | ...`. */
  connectorId: string
  /** `'post-created' | 'send_email' | 'create_event' | 'post_message' | ...`. */
  actionKind: string
  /** Recipient's clearance (IFC audience ceiling). v1 callers use `'public'`. */
  audienceClearance: Sensitivity
  status: ConnectorActionStatus
  /** Connector-returned id (audit `external_id` + idempotency key). Absent on failures. */
  externalId?: string | null
  payload: Record<string, unknown>
  /** Extras into the Episode's `source_ref` (permalinks, thread ids, ...). */
  sourceRefExtras?: Record<string, unknown>
  /** Defaults to `new Date()`. */
  occurredAt?: Date
  /** Backlink to a commitment memory when the action broadcasts it. */
  sourceMemoryId?: string | null
  /** Provenance — Episodes that drove this action. */
  sourceEpisodeIds?: string[]
}

/** Result of the classifier preflight gate (no audit row written). */
export type ConnectorActionPreflight = {
  responseCeiling: Sensitivity
  retrievalMax: Sensitivity
  classifierDetected: Sensitivity
  classifierMatches: string[]
  /** True iff classifier outranks ceiling AND env flag enforces. */
  shouldDeny: boolean
  /** True iff classifier outranks ceiling AND env flag is OFF (shadow). */
  shadowOnly: boolean
}

export type EmitConnectorActionResult = {
  status: ConnectorActionStatus
  classifierMatches?: string[]
  shadowDenied?: boolean
  denied?: boolean
}

/**
 * The audit deps PLUS bound `emit`/`preflight` methods. The composition root's
 * `buildConnectorActionAudit` binds the closed impl; open callers invoke the
 * methods (no import of the closed primitive).
 */
export interface ConnectorActionAudit extends ConnectorActionAuditDeps {
  /** Classify a payload BEFORE the network call (no audit row written). */
  preflight(
    params: Pick<ConnectorActionEmitParams, 'audienceClearance' | 'payload'>,
  ): ConnectorActionPreflight
  /** Emit the `connector_action` Episode + audit row after the action runs. */
  emit(
    idCtx: { userId: string; assistantId: string },
    params: ConnectorActionEmitParams & { preflight?: ConnectorActionPreflight },
  ): Promise<EmitConnectorActionResult>
}

/** Bind per-turn deps into an audit object. Composition root wires the real impl. */
export type BuildConnectorActionAudit = (deps: ConnectorActionAuditDeps) => ConnectorActionAudit
