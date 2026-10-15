/**
 * Staged commercial binding onto canonical Office paths. Drafts are created
 * from the admitted template version (shell, stored snapshot, committed
 * version, live document); later changes rewrite only bound cells through one
 * canonical batch command and checkpoint a version; issue releases through the
 * same exact-head release used by the Office UI.
 * Spec: docs/architecture/features/crm-commercial-operations.md -> Invoice preparation
 *
 * [COMP:crm/invoice-preparation]
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  officeSnapshotPreconditionHash,
  officeStateVector,
  recalculateSpreadsheet,
  snapshotToYDoc,
  spreadsheetCellDisplayValue,
  type OfficeCommand,
  type OfficeTemplateBundle,
  type SpreadsheetSnapshot,
} from '@use-brian/office-model'
import { fillSpreadsheetTemplateValues, type SpreadsheetTemplateValue, type SpreadsheetTokenCell } from '../office/spreadsheet-generation.js'
import { executeOfficeRelease, type OfficeReleaseRequest, type OfficeReleaseRouteDeps } from '../routes/office-releases.js'
import { query } from '../db/client.js'
import type { createFilesApi } from '../files/files-api.js'
import type { createOfficeArtifactStore } from '../db/office-artifacts.js'
import type { createOfficeLiveStore } from '../db/office-live.js'

export type CrmOfficeScope = { sensitivity: 'public' | 'internal' | 'confidential'; compartments: string[]; projectIds: string[] }
export type CrmBoundCell = SpreadsheetTokenCell
export type CrmCellWrite = { sheetId: string; cellId: string; address: string; value: SpreadsheetTemplateValue }
export type CrmReleaseOutcome = Awaited<ReturnType<typeof executeOfficeRelease>>

export type CrmOfficeBindingDeps = {
  readTemplateBundle(userId: string, workspaceId: string, templateVersionId: string): Promise<OfficeTemplateBundle | null>
  artifacts: Pick<ReturnType<typeof createOfficeArtifactStore>, 'createShell' | 'commitVersion' | 'get' | 'deleteEmptyShell' | 'getHeadVersion'>
  live: Pick<ReturnType<typeof createOfficeLiveStore>, 'initialize' | 'get' | 'appendCommand'>
  /** Store snapshot bytes as an Office-owned, scoped file and return its id. */
  writeSnapshotFile(params: { userId: string; workspaceId: string; artifactId: string; version: number; hash: string; bytes: Uint8Array; scope: CrmOfficeScope }): Promise<string>
  /** Record the live document's new base version after a checkpoint. */
  setLiveBaseVersion(artifactId: string, version: number): Promise<void>
  release(userId: string, artifactId: string, request: OfficeReleaseRequest): Promise<CrmReleaseOutcome>
}

export type CrmOfficeBindingPort = ReturnType<typeof createCrmOfficeBinding>

export class CrmOfficeBindingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'CrmOfficeBindingError'
  }
}

export function createCrmOfficeBinding(deps: CrmOfficeBindingDeps) {
  async function checkpoint(userId: string, workspaceId: string, artifactId: string, scope: CrmOfficeScope, summary: string) {
    const artifact = await deps.artifacts.get(userId, artifactId)
    const live = await deps.live.get(userId, artifactId)
    if (!artifact || !live) throw new CrmOfficeBindingError('office_artifact_unavailable', 'The Office artifact is unavailable.')
    const bytes = new TextEncoder().encode(JSON.stringify(live.snapshot))
    const fileId = await deps.writeSnapshotFile({ userId, workspaceId, artifactId, version: artifact.headVersion + 1, hash: live.canonicalHash, bytes, scope })
    const version = await deps.artifacts.commitVersion({
      userId, artifactId, snapshotTitle: live.snapshot.title, expectedVersion: artifact.headVersion, snapshotFileId: fileId,
      snapshotHash: live.canonicalHash, operationClock: officeStateVector(snapshotToYDoc(live.snapshot)), schemaVersion: live.snapshot.schemaVersion,
      capabilityVersion: live.snapshot.capabilityVersion, origin: 'manual', authorType: 'system', summary, checkpointKind: 'revision',
    })
    if (!version) throw new CrmOfficeBindingError('office_version_conflict', 'The Office artifact changed concurrently.')
    await deps.setLiveBaseVersion(artifactId, version.version)
    return version.version
  }

  return {
    async createDraft(params: { userId: string; workspaceId: string; templateVersionId: string; title: string; scope: CrmOfficeScope
      values: Record<string, SpreadsheetTemplateValue>; deferred: ReadonlySet<string> }): Promise<{ artifactId: string; version: number; cells: CrmBoundCell[] }> {
      const bundle = await deps.readTemplateBundle(params.userId, params.workspaceId, params.templateVersionId)
      if (!bundle || bundle.family !== 'spreadsheet') throw new CrmOfficeBindingError('template_unavailable', 'The admitted spreadsheet template version is unavailable.')
      const shell = await deps.artifacts.createShell({ userId: params.userId, workspaceId: params.workspaceId, family: 'spreadsheet', title: params.title,
        templateVersionId: params.templateVersionId, capabilityVersion: bundle.snapshot.capabilityVersion, sensitivity: params.scope.sensitivity,
        requiredCompartments: params.scope.compartments, projectIds: params.scope.projectIds })
      try {
        const filled = fillSpreadsheetTemplateValues({ template: bundle, artifactId: shell.id, workspaceId: params.workspaceId,
          templateVersionId: params.templateVersionId, title: params.title, values: params.values, deferred: params.deferred })
        const bytes = new TextEncoder().encode(JSON.stringify(filled.snapshot))
        const hash = createHash('sha256').update(bytes).digest('hex')
        const fileId = await deps.writeSnapshotFile({ userId: params.userId, workspaceId: params.workspaceId, artifactId: shell.id, version: 1, hash, bytes, scope: params.scope })
        const version = await deps.artifacts.commitVersion({
          userId: params.userId, artifactId: shell.id, snapshotTitle: filled.snapshot.title, expectedVersion: 0, snapshotFileId: fileId, snapshotHash: hash,
          operationClock: officeStateVector(snapshotToYDoc(filled.snapshot)), schemaVersion: filled.snapshot.schemaVersion,
          capabilityVersion: filled.snapshot.capabilityVersion, origin: 'generation', authorType: 'system', summary: 'Commercial preparation draft', checkpointKind: 'generation',
        })
        if (!version) throw new CrmOfficeBindingError('office_version_conflict', 'The Office draft could not be committed.')
        await deps.live.initialize({ userId: params.userId, artifactId: shell.id, snapshot: filled.snapshot })
        await deps.setLiveBaseVersion(shell.id, version.version)
        return { artifactId: shell.id, version: version.version, cells: filled.tokenCells }
      } catch (error) {
        await deps.artifacts.deleteEmptyShell(params.userId, shell.id).catch(() => false)
        throw error
      }
    },

    /** Rewrite bound cells in one canonical batch and checkpoint. Cells already equal are left alone. */
    async writeCells(params: { userId: string; workspaceId: string; artifactId: string; scope: CrmOfficeScope; actorUserId: string; cells: CrmCellWrite[]; summary: string }): Promise<{ version: number; changed: number }> {
      const live = await deps.live.get(params.userId, params.artifactId)
      const artifact = await deps.artifacts.get(params.userId, params.artifactId)
      if (!live || !artifact || live.snapshot.family !== 'spreadsheet') throw new CrmOfficeBindingError('office_artifact_unavailable', 'The Office artifact is unavailable.')
      const snapshot = live.snapshot as SpreadsheetSnapshot
      const changed = params.cells.filter((write) => {
        const cell = snapshot.worksheets.find((sheet) => sheet.id === write.sheetId)?.cells.find((candidate) => candidate.id === write.cellId)
        return !cell || cell.formula !== undefined || cell.valueType !== write.value.valueType || cell.value !== write.value.value
      })
      if (!changed.length) {
        const head = await deps.artifacts.getHeadVersion(params.userId, params.artifactId)
        const version = head?.snapshotHash === live.canonicalHash ? artifact.headVersion
          : await checkpoint(params.userId, params.workspaceId, params.artifactId, params.scope, params.summary)
        return { version, changed: 0 }
      }
      const envelope = { artifactId: params.artifactId, baseVersion: live.baseVersion, actor: { type: 'user' as const, id: params.actorUserId }, origin: 'manual' as const }
      const command: OfficeCommand = {
        ...envelope, commandId: randomUUID(), kind: 'batch', expectedSnapshotHash: officeSnapshotPreconditionHash(snapshot),
        commands: changed.map((write) => ({ ...envelope, commandId: randomUUID(), kind: 'setSpreadsheetCell' as const, sheetId: write.sheetId,
          cellId: write.cellId, address: write.address, valueType: write.value.valueType, value: write.value.value })),
      } as OfficeCommand
      const applied = await deps.live.appendCommand({ userId: params.userId, artifactId: params.artifactId, expectedSeq: live.seq, command })
      if (!applied || applied === 'conflict') throw new CrmOfficeBindingError('office_version_conflict', 'The Office artifact changed concurrently. Retry reads the current state.')
      return { version: await checkpoint(params.userId, params.workspaceId, params.artifactId, params.scope, params.summary), changed: changed.length }
    },

    /** Recalculated display and raw values for `Sheet!A1` references in the live document. */
    async readCells(params: { userId: string; artifactId: string; refs: string[] }): Promise<Record<string, { value: unknown; display: string } | null>> {
      const live = await deps.live.get(params.userId, params.artifactId)
      if (!live || live.snapshot.family !== 'spreadsheet') throw new CrmOfficeBindingError('office_artifact_unavailable', 'The Office artifact is unavailable.')
      const calculated = recalculateSpreadsheet(live.snapshot as SpreadsheetSnapshot).snapshot
      return Object.fromEntries(params.refs.map((ref) => {
        const [sheetName, address] = ref.split('!') as [string, string]
        const cell = calculated.worksheets.find((sheet) => sheet.name === sheetName)?.cells.find((candidate) => candidate.address === address)
        return [ref, cell ? { value: cell.formula !== undefined ? cell.calculatedValue ?? null : cell.value, display: spreadsheetCellDisplayValue(cell) } : null]
      }))
    },

    async sheetId(params: { userId: string; artifactId: string; sheetName: string }): Promise<string | null> {
      const live = await deps.live.get(params.userId, params.artifactId)
      if (!live || live.snapshot.family !== 'spreadsheet') return null
      return (live.snapshot as SpreadsheetSnapshot).worksheets.find((sheet) => sheet.name === params.sheetName)?.id ?? null
    },

    release: deps.release,
  }
}

/** Compose the binding from canonical Office stores, storage and the shared release path. */
export function createCrmOfficeBindingFromOffice(deps: {
  filesApi: ReturnType<typeof createFilesApi>
  artifacts: CrmOfficeBindingDeps['artifacts']
  live: CrmOfficeBindingDeps['live']
  readTemplateBundle: CrmOfficeBindingDeps['readTemplateBundle']
  releaseDeps: OfficeReleaseRouteDeps
}) {
  return createCrmOfficeBinding({
    readTemplateBundle: deps.readTemplateBundle,
    artifacts: deps.artifacts,
    live: deps.live,
    async writeSnapshotFile(params) {
      const saved = await deps.filesApi.writeBytes({ workspaceId: params.workspaceId, userId: params.userId, assistantKind: 'standard', clearance: 'confidential',
        writeCompartments: params.scope.compartments, writeProjectIds: params.scope.projectIds },
      { path: `/office/artifacts/${params.artifactId}/versions/${params.version}-${params.hash}.json`, bytes: params.bytes, mime: 'application/json', sensitivity: 'confidential' })
      if (!saved.ok) throw new CrmOfficeBindingError('office_storage_failed', `Office snapshot save failed: ${saved.error.kind}`)
      return saved.value.id
    },
    async setLiveBaseVersion(artifactId, version) {
      await query('UPDATE office_collab_documents SET base_version=$2,updated_at=now() WHERE artifact_id=$1', [artifactId, version])
    },
    release: (userId, artifactId, request) => executeOfficeRelease(deps.releaseDeps, { userId, artifactId, request }),
  })
}
