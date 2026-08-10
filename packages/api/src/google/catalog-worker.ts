/**
 * Recurring metadata-only Google Drive catalog worker.
 *
 * Catalog descriptors contain names, paths, MIME types, timestamps, links,
 * and provider ids. FilesApi embeds that small descriptor through the normal
 * workspace-file embedding queue; this worker never downloads Drive content
 * and never invokes Pipeline B.
 *
 * [COMP:integrations/gdrive-enrichment]
 */

import { createHash } from 'node:crypto'
import type { FilesApi, FilesContext } from '@use-brian/core'
import type { ConnectorInstanceStore } from '../db/connector-instance-store.js'
import {
  claimNextGDriveCatalogSync,
  completeGDriveCatalogSync,
  isGDriveCatalogRunCurrent,
  listStaleGDriveCatalogArtifacts,
  markGDriveCatalogSyncFailed,
  setGDriveCatalogArtifact,
  updateGDriveCatalogProgress,
  upsertGDriveCatalogEntry,
  type GDriveCatalogEntry,
  type GDriveCatalogStoredEntry,
  type GDriveCatalogSyncJob,
} from '../db/gdrive-catalog-store.js'
import {
  mintGDriveInstanceAccessToken,
  scanGDriveCatalog,
  type GDriveCatalogScanResult,
} from './drive-catalog.js'

const DEFAULT_INTERVAL_MS = 15_000
const PROGRESS_EVERY = 25

type CatalogFilesPort = Pick<FilesApi, 'write' | 'read' | 'delete'>

export type GDriveCatalogWorkerDeps = {
  filesApi: CatalogFilesPort
  connectorInstanceStore: Pick<ConnectorInstanceStore, 'getCredentialsSystem'>
  claim?: () => Promise<GDriveCatalogSyncJob | null>
  scan?: (job: GDriveCatalogSyncJob) => Promise<GDriveCatalogScanResult>
  isCurrent?: typeof isGDriveCatalogRunCurrent
  upsertEntry?: typeof upsertGDriveCatalogEntry
  setArtifact?: typeof setGDriveCatalogArtifact
  updateProgress?: typeof updateGDriveCatalogProgress
  listStaleArtifacts?: typeof listStaleGDriveCatalogArtifacts
  complete?: typeof completeGDriveCatalogSync
  markFailed?: typeof markGDriveCatalogSyncFailed
  intervalMs?: number
}

export type GDriveCatalogWorker = {
  start: () => void
  stop: () => void
  tick: () => Promise<void>
  isRunning: () => boolean
}

function hashPart(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

function cleanInline(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function descriptorPath(job: GDriveCatalogSyncJob, entry: GDriveCatalogEntry): string {
  return `/imports/google-drive/${job.connectorInstanceId}/catalog/${hashPart(entry.externalFileId)}.md`
}

function renderDescriptor(entry: GDriveCatalogEntry): { content: string; summary: string } {
  const title = cleanInline(entry.name) || 'Untitled Drive file'
  const folder = entry.folderPath.map(cleanInline).filter(Boolean).join(' / ')
  const lines = [
    `# ${title}`,
    '',
    'Google Drive catalog metadata. File content has not been downloaded.',
    '',
    `- File ID: ${cleanInline(entry.externalFileId)}`,
    `- MIME type: ${cleanInline(entry.mimeType)}`,
    `- Source version: ${cleanInline(entry.sourceVersion)}`,
  ]
  if (folder) lines.push(`- Folder: ${folder}`)
  if (entry.modifiedTime) lines.push(`- Modified: ${cleanInline(entry.modifiedTime)}`)
  if (entry.sizeBytes !== null) lines.push(`- Size: ${entry.sizeBytes} bytes`)
  if (entry.webViewLink) lines.push(`- Link: ${cleanInline(entry.webViewLink)}`)
  return {
    content: `${lines.join('\n')}\n`,
    summary: folder
      ? `Google Drive file in ${folder}. ${entry.mimeType}`
      : `Google Drive file. ${entry.mimeType}`,
  }
}

function entryChanged(previous: GDriveCatalogStoredEntry | null, current: GDriveCatalogEntry): boolean {
  if (!previous || !previous.artifactFileId) return true
  return previous.name !== current.name ||
    previous.mimeType !== current.mimeType ||
    previous.sourceVersion !== current.sourceVersion ||
    previous.sizeBytes !== current.sizeBytes ||
    previous.webViewLink !== current.webViewLink ||
    JSON.stringify(previous.parentIds) !== JSON.stringify(current.parentIds) ||
    JSON.stringify(previous.folderPath) !== JSON.stringify(current.folderPath)
}

async function deleteArtifact(filesApi: CatalogFilesPort, ctx: FilesContext, idOrPath: string): Promise<void> {
  const removed = await filesApi.delete(ctx, idOrPath)
  if (!removed.ok && removed.error.kind !== 'not_found') {
    throw new Error(`Could not remove stale Drive catalog descriptor: ${removed.error.kind}`)
  }
}

async function writeDescriptor(input: {
  filesApi: CatalogFilesPort
  ctx: FilesContext
  job: GDriveCatalogSyncJob
  entry: GDriveCatalogEntry
}): Promise<string> {
  const path = descriptorPath(input.job, input.entry)
  const descriptor = renderDescriptor(input.entry)
  const written = await input.filesApi.write(input.ctx, {
    path,
    content: descriptor.content,
    mime: 'text/markdown',
    title: cleanInline(input.entry.name) || 'Untitled Drive file',
    summary: descriptor.summary,
    tags: ['google-drive', 'drive-catalog'],
    sensitivity: 'confidential',
  })
  if (written.ok) return written.value.id
  if (written.error.kind !== 'conflict') {
    throw new Error(`Could not store Drive catalog descriptor: ${written.error.kind}`)
  }
  const existing = await input.filesApi.read(input.ctx, path)
  if (existing.ok && existing.value.content === descriptor.content) return existing.value.file.id
  await deleteArtifact(input.filesApi, input.ctx, path)
  const replaced = await input.filesApi.write(input.ctx, {
    path,
    content: descriptor.content,
    mime: 'text/markdown',
    title: cleanInline(input.entry.name) || 'Untitled Drive file',
    summary: descriptor.summary,
    tags: ['google-drive', 'drive-catalog'],
    sensitivity: 'confidential',
  })
  if (!replaced.ok) throw new Error(`Could not replace Drive catalog descriptor: ${replaced.error.kind}`)
  return replaced.value.id
}

export function createGDriveCatalogWorker(deps: GDriveCatalogWorkerDeps): GDriveCatalogWorker {
  const claim = deps.claim ?? claimNextGDriveCatalogSync
  const isCurrent = deps.isCurrent ?? isGDriveCatalogRunCurrent
  const upsertEntry = deps.upsertEntry ?? upsertGDriveCatalogEntry
  const setArtifact = deps.setArtifact ?? setGDriveCatalogArtifact
  const updateProgress = deps.updateProgress ?? updateGDriveCatalogProgress
  const listStaleArtifacts = deps.listStaleArtifacts ?? listStaleGDriveCatalogArtifacts
  const complete = deps.complete ?? completeGDriveCatalogSync
  const markFailed = deps.markFailed ?? markGDriveCatalogSyncFailed
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  const scan = deps.scan ?? (async (job: GDriveCatalogSyncJob) => {
    const accessToken = await mintGDriveInstanceAccessToken({
      connectorInstanceId: job.connectorInstanceId,
      connectorInstanceStore: deps.connectorInstanceStore,
    })
    return scanGDriveCatalog({
      accessToken,
      syncScope: job.syncScope,
      selectedFolders: job.selectedFolders,
    })
  })

  let timer: ReturnType<typeof setInterval> | undefined
  let running = false

  async function processJob(job: GDriveCatalogSyncJob): Promise<void> {
    const scanResult = await scan(job)
    if (!await isCurrent(job.id, job.generation)) return
    const ctx: FilesContext = { workspaceId: job.workspaceId, userId: job.actingUserId }
    let filesSeen = 0
    let filesIndexed = 0

    for (const entry of scanResult.entries) {
      if (!await isCurrent(job.id, job.generation)) return
      const previous = await upsertEntry({ job, entry })
      filesSeen += 1
      if (entry.isFolder) {
        if (previous?.artifactFileId) await deleteArtifact(deps.filesApi, ctx, previous.artifactFileId)
      } else {
        if (entryChanged(previous, entry)) {
          if (previous?.artifactFileId) {
            await deleteArtifact(deps.filesApi, ctx, previous.artifactFileId)
            await setArtifact({
              workspaceId: job.workspaceId,
              connectorInstanceId: job.connectorInstanceId,
              externalFileId: entry.externalFileId,
              generation: job.generation,
              artifactFileId: null,
            })
          }
          const artifactFileId = await writeDescriptor({ filesApi: deps.filesApi, ctx, job, entry })
          await setArtifact({
            workspaceId: job.workspaceId,
            connectorInstanceId: job.connectorInstanceId,
            externalFileId: entry.externalFileId,
            generation: job.generation,
            artifactFileId,
          })
        }
        filesIndexed += 1
      }
      if (filesSeen % PROGRESS_EVERY === 0) {
        await updateProgress({ id: job.id, generation: job.generation, filesSeen, filesIndexed })
      }
    }

    if (!await isCurrent(job.id, job.generation)) return
    const staleArtifacts = await listStaleArtifacts({
      workspaceId: job.workspaceId,
      connectorInstanceId: job.connectorInstanceId,
      generation: job.generation,
    })
    for (const artifactFileId of staleArtifacts) {
      if (!await isCurrent(job.id, job.generation)) return
      await deleteArtifact(deps.filesApi, ctx, artifactFileId)
    }
    await complete({
      id: job.id,
      workspaceId: job.workspaceId,
      connectorInstanceId: job.connectorInstanceId,
      generation: job.generation,
      filesSeen,
      filesIndexed,
    })
  }

  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      for (;;) {
        const job = await claim()
        if (!job) break
        try {
          await processJob(job)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          await markFailed(job.id, job.generation, message).catch(() => ({ retrying: false }))
          console.error(`[gdrive-catalog-worker] job ${job.id} failed: ${message}`)
        }
      }
    } catch (err) {
      console.error('[gdrive-catalog-worker] tick error:', err)
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
