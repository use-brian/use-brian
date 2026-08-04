/**
 * Restartable lossless LinkedIn import worker.
 *
 * [COMP:brain/linkedin-import]
 */

import type { FilesApi, FilesContext } from '@use-brian/core'

import { findUserById } from '../db/users.js'
import { getOrCreateSelfEntity } from '../db/entities-store.js'
import {
  linkedinImportStore,
  type LinkedInImportMember,
  type LinkedInImportStore,
} from '../db/linkedin-import-store.js'
import { indexFileArtifact, type IndexFileArtifactResult } from '../files/artifact-index.js'
import { inspectLinkedInArchive, sha256 } from './archive.js'
import { parseLinkedInCsv } from './csv.js'
import { buildLinkedInProjection } from './projector.js'
import type {
  LinkedInArchiveMember,
  LinkedInImportRun,
  ParsedLinkedInCsv,
} from './types.js'

const DEFAULT_INTERVAL_MS = 15_000

export type LinkedInImportWorkerDeps = {
  filesApi: Pick<FilesApi, 'writeBytes' | 'stat' | 'readBytes'>
  store?: LinkedInImportStore
  inspectArchive?: (bytes: Buffer) => Promise<LinkedInArchiveMember[]>
  indexArtifact?: (input: {
    fileId: string
    workspaceId: string
    text: string
    actingUserId: string
  }) => Promise<IndexFileArtifactResult>
  resolveSelfEntity?: (run: LinkedInImportRun) => Promise<{ id: string }>
  intervalMs?: number
}

export type LinkedInImportWorker = {
  start: () => void
  stop: () => void
  tick: () => Promise<void>
  isRunning: () => boolean
}

function memberArtifactPath(run: LinkedInImportRun, memberPath: string): string {
  return `/imports/linkedin/${run.actingUserId}/${run.archiveSha256}/members/${memberPath}`
}

function isIndexableText(member: LinkedInArchiveMember): boolean {
  return member.mime.startsWith('text/') ||
    member.mime === 'application/json' ||
    member.mime === 'application/xml'
}

async function defaultResolveSelfEntity(run: LinkedInImportRun): Promise<{ id: string }> {
  const user = await findUserById(run.actingUserId)
  if (!user) throw new Error(`LinkedIn import actor ${run.actingUserId} no longer exists`)
  return getOrCreateSelfEntity({
    userId: run.actingUserId,
    workspaceId: run.workspaceId,
    displayName: user.name || user.email || 'Me',
  })
}

async function ensureMemberArtifact(input: {
  filesApi: LinkedInImportWorkerDeps['filesApi']
  run: LinkedInImportRun
  member: LinkedInArchiveMember
  ledgerMember: LinkedInImportMember
}): Promise<string> {
  const { filesApi, run, member, ledgerMember } = input
  const ctx: FilesContext = {
    workspaceId: run.workspaceId,
    userId: run.actingUserId,
    assistantId: run.assistantId,
  }
  if (ledgerMember.fileId) {
    const existing = await filesApi.readBytes(ctx, ledgerMember.fileId)
    if (!existing.ok) throw new Error(`LinkedIn member artifact ${ledgerMember.fileId} is missing`)
    if (sha256(existing.value.bytes) !== member.contentSha256) {
      throw new Error(`LinkedIn member artifact hash mismatch for ${member.path}`)
    }
    return ledgerMember.fileId
  }

  const path = memberArtifactPath(run, member.path)
  const written = await filesApi.writeBytes(ctx, {
    path,
    bytes: member.bytes,
    mime: member.mime,
    title: member.path,
    summary: `Original member from LinkedIn archive ${run.archiveName}`,
    tags: ['linkedin-import', 'source-evidence'],
    sensitivity: 'confidential',
  })
  if (written.ok) return written.value.id
  if (written.error.kind !== 'conflict') {
    throw new Error(`Could not store ${member.path}: ${written.error.kind}`)
  }
  const existing = await filesApi.readBytes(ctx, path)
  if (!existing.ok) throw new Error(`Conflicting LinkedIn member artifact could not be read: ${member.path}`)
  if (sha256(existing.value.bytes) !== member.contentSha256) {
    throw new Error(`Conflicting LinkedIn member artifact has different bytes: ${member.path}`)
  }
  return existing.value.file.id
}

export function createLinkedInImportWorker(deps: LinkedInImportWorkerDeps): LinkedInImportWorker {
  const store = deps.store ?? linkedinImportStore
  const inspectArchive = deps.inspectArchive ?? inspectLinkedInArchive
  const indexArtifact = deps.indexArtifact ?? indexFileArtifact
  const resolveSelfEntity = deps.resolveSelfEntity ?? defaultResolveSelfEntity
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  let timer: ReturnType<typeof setInterval> | undefined
  let running = false

  async function processRun(run: LinkedInImportRun): Promise<void> {
    if (!run.leaseToken) throw new Error('LinkedIn import claim has no lease token')
    const leaseToken = run.leaseToken
    const ctx: FilesContext = {
      workspaceId: run.workspaceId,
      userId: run.actingUserId,
      assistantId: run.assistantId,
    }
    if (!run.archiveFileId) throw new Error('LinkedIn import has no stored archive file')
    const archive = await deps.filesApi.readBytes(ctx, run.archiveFileId)
    if (!archive.ok) throw new Error(`Could not read stored LinkedIn archive: ${archive.error.kind}`)
    const archiveBytes = Buffer.from(archive.value.bytes)
    if (sha256(archiveBytes) !== run.archiveSha256) {
      throw new Error('Stored LinkedIn archive hash does not match the upload hash')
    }

    await store.setStage(run.id, leaseToken, 'validating_archive')
    const members = await inspectArchive(archiveBytes)
    const csvs: ParsedLinkedInCsv[] = []

    for (let i = 0; i < members.length; i += 1) {
      const member = members[i]
      await store.setStage(run.id, leaseToken, `member:${i + 1}/${members.length}:${member.path}`)
      const ledgerMember = await store.upsertMember({
        runId: run.id,
        workspaceId: run.workspaceId,
        memberPath: member.path,
        contentSha256: member.contentSha256,
        compressedSize: member.compressedSize,
        sizeBytes: member.sizeBytes,
        mime: member.mime,
      })
      try {
        const fileId = await ensureMemberArtifact({
          filesApi: deps.filesApi,
          run,
          member,
          ledgerMember,
        })
        if (ledgerMember.fileId !== fileId) await store.setMemberArtifact(ledgerMember.id, fileId)

        if (isIndexableText(member) && member.bytes.length > 0) {
          await indexArtifact({
            fileId,
            workspaceId: run.workspaceId,
            text: member.bytes.toString('utf8'),
            actingUserId: run.actingUserId,
          })
        }

        if (member.mime === 'text/csv') {
          const parsed = parseLinkedInCsv(member.path, member.bytes)
          await store.upsertRows({
            runId: run.id,
            memberId: ledgerMember.id,
            workspaceId: run.workspaceId,
            rows: parsed.rows,
          })
          await store.completeMember({
            memberId: ledgerMember.id,
            status: 'completed',
            headerRowOrdinal: parsed.headerRowOrdinal,
            headerCells: parsed.headerCells,
            recordCount: parsed.rows.length,
          })
          csvs.push(parsed)
        } else {
          await store.completeMember({
            memberId: ledgerMember.id,
            status: 'stored',
            headerRowOrdinal: null,
            headerCells: null,
            recordCount: 0,
          })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await store.failMember(ledgerMember.id, message).catch(() => {})
        throw err
      }
    }

    await store.setStage(run.id, leaseToken, 'projecting_graph')
    const [self, existingIdentities] = await Promise.all([
      resolveSelfEntity(run),
      store.listIdentities({ workspaceId: run.workspaceId, userId: run.actingUserId }),
    ])
    const projection = buildLinkedInProjection({
      runId: run.id,
      archiveSha256: run.archiveSha256,
      selfEntityId: self.id,
      csvs,
      existingIdentities,
    })
    await store.persistProjection(run, projection)

    await store.setStage(run.id, leaseToken, 'reconciling')
    await store.completeRun({ runId: run.id, leaseToken })
  }

  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      for (;;) {
        const run = await store.claim()
        if (!run) break
        try {
          await processRun(run)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (run.leaseToken) {
            await store.markFailed(run.id, run.leaseToken, message).catch(() => ({ retrying: false }))
          }
          console.error(`[linkedin-import] run ${run.id} failed: ${message}`)
        }
      }
    } catch (err) {
      console.error('[linkedin-import] claim failed:', err)
    } finally {
      running = false
    }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => void tick(), intervalMs)
      void tick()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
    },
    tick,
    isRunning: () => running,
  }
}
