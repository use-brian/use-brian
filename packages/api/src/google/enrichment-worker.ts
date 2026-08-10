/**
 * Progressive Google Drive enrichment worker.
 *
 * Lazy jobs re-open one exact OAuth instance and run Pipeline B once per Drive
 * version. Offline jobs are already enriched, so they only materialize and
 * index the supplied deterministic artifact.
 *
 * [COMP:integrations/gdrive-enrichment]
 */

import { createHash } from 'node:crypto'
import { parseFileContent, type FilesApi, type FilesContext } from '@use-brian/core'
import { getConnectorConfig } from '../connector-config.js'
import type { ConnectorInstanceStore } from '../db/connector-instance-store.js'
import {
  claimNextGDriveEnrichment,
  enqueueGDriveLazyEnrichment,
  markGDriveEnrichmentDone,
  markGDriveEnrichmentFailed,
  markGDriveEnrichmentSuperseded,
  type GDriveEnrichmentJob,
} from '../db/gdrive-enrichment-store.js'
import { getGDriveCatalogReadPolicy } from '../db/gdrive-catalog-store.js'
import { indexFileArtifact, type IndexFileArtifactResult } from '../files/artifact-index.js'
import type { BrainEpisodeIngestor } from '../ingest-port.js'
import {
  getDriveFileBytesWithMetadata,
  refreshGoogleAccessToken,
  unpackGoogleRefreshCredential,
  type DriveFile,
} from './client.js'
import { renderOfflineGDriveEnrichment } from './enrichment-bundle.js'

const DEFAULT_INTERVAL_MS = 15_000
const MAX_NATIVE_TEXT_CHARS = 2_000_000
const CONTENT_REF_MAX_CHARS = 16_000

type GDriveEnrichmentFilesPort = Pick<FilesApi, 'write' | 'read'>

export type GDriveEnrichmentWorkerDeps = {
  filesApi: GDriveEnrichmentFilesPort
  connectorInstanceStore: Pick<ConnectorInstanceStore, 'getCredentialsSystem'>
  brainIngest?: BrainEpisodeIngestor
  claim?: () => Promise<GDriveEnrichmentJob | null>
  enqueueLazy?: typeof enqueueGDriveLazyEnrichment
  markDone?: typeof markGDriveEnrichmentDone
  markFailed?: typeof markGDriveEnrichmentFailed
  markSuperseded?: typeof markGDriveEnrichmentSuperseded
  fetchDriveContent?: (connectorInstanceId: string, externalFileId: string) => Promise<{
    file: DriveFile
    content: string
  }>
  index?: (input: {
    fileId: string
    workspaceId: string
    text: string
    actingUserId: string
  }) => Promise<IndexFileArtifactResult>
  /** PDF/image distillation port. Boot wires the same media backend as file ingest. */
  distill?: (input: { buffer: Buffer; mime: string }) => Promise<string>
  intervalMs?: number
}

export type GDriveEnrichmentWorker = {
  start: () => void
  stop: () => void
  tick: () => Promise<void>
  isRunning: () => boolean
}

function hashPart(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20)
}

function safeName(value: string): string {
  const cleaned = value.normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '')
  return (cleaned || 'drive-file').slice(0, 120)
}

function artifactPath(job: GDriveEnrichmentJob): string {
  return `/imports/google-drive/${job.connectorInstanceId}/${hashPart(job.externalFileId)}/${hashPart(job.sourceVersion)}-${safeName(job.fileName)}.md`
}

function driveVersion(file: DriveFile): string {
  return file.version?.trim() || file.modifiedTime?.trim() || ''
}

function renderNativeArtifact(job: GDriveEnrichmentJob, file: DriveFile, content: string): string {
  const lines = [
    `# ${file.name || job.fileName}`,
    '',
    '## Google Drive source',
    '',
    `- File ID: ${file.id}`,
    `- Version: ${driveVersion(file)}`,
    `- MIME type: ${file.mimeType}`,
  ]
  if (file.modifiedTime) lines.push(`- Modified: ${file.modifiedTime}`)
  if (file.webViewLink) lines.push(`- Link: ${file.webViewLink}`)
  if (file.parents?.length) lines.push(`- Parent IDs: ${file.parents.join(', ')}`)
  if (content.trim()) lines.push('', '## Source content', '', content.trim())
  return `${lines.join('\n')}\n`
}

async function storeArtifact(
  filesApi: GDriveEnrichmentFilesPort,
  job: GDriveEnrichmentJob,
  text: string,
  summary: string,
): Promise<string> {
  const ctx: FilesContext = {
    workspaceId: job.workspaceId,
    userId: job.actingUserId,
    assistantId: job.assistantId ?? undefined,
  }
  const path = artifactPath(job)
  const written = await filesApi.write(ctx, {
    path,
    content: text,
    mime: 'text/markdown',
    title: job.fileName,
    summary,
    tags: ['google-drive', 'drive-enrichment', job.mode],
    sensitivity: 'confidential',
  })
  if (written.ok) return written.value.id
  if (written.error.kind !== 'conflict') {
    throw new Error(`Could not store Drive enrichment artifact: ${written.error.kind}`)
  }
  const existing = await filesApi.read(ctx, path)
  if (!existing.ok) throw new Error('Conflicting Drive enrichment artifact could not be read')
  if (existing.value.content !== text) {
    throw new Error('Conflicting Drive enrichment artifact has different content')
  }
  return existing.value.file.id
}

export function createGDriveEnrichmentWorker(deps: GDriveEnrichmentWorkerDeps): GDriveEnrichmentWorker {
  const claim = deps.claim ?? claimNextGDriveEnrichment
  const enqueueLazy = deps.enqueueLazy ?? enqueueGDriveLazyEnrichment
  const markDone = deps.markDone ?? markGDriveEnrichmentDone
  const markFailed = deps.markFailed ?? markGDriveEnrichmentFailed
  const markSuperseded = deps.markSuperseded ?? markGDriveEnrichmentSuperseded
  const index = deps.index ?? indexFileArtifact
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS

  const fetchDriveContent = deps.fetchDriveContent ?? (async (connectorInstanceId, externalFileId) => {
    const stored = await deps.connectorInstanceStore.getCredentialsSystem(connectorInstanceId)
    const encoded = stored?.client_secret
    if (!encoded) throw new Error('Google Drive connector credentials are missing')
    const grant = unpackGoogleRefreshCredential(encoded)
    const deployment = getConnectorConfig('google')
    const clientId = grant.appClientId ?? deployment?.clientId
    const clientSecret = grant.appClientSecret ?? deployment?.clientSecret
    if (!clientId || !clientSecret) throw new Error('Google OAuth app is not configured for this Drive grant')
    const token = await refreshGoogleAccessToken(grant.refreshToken, clientId, clientSecret)
    const downloaded = await getDriveFileBytesWithMetadata(token, externalFileId)
    const buffer = Buffer.from(downloaded.bytes)
    const needsDistill = downloaded.mimeType === 'application/pdf' || downloaded.mimeType.startsWith('image/')
    if (needsDistill) {
      if (!deps.distill) throw new Error(`Drive enrichment needs a distiller for ${downloaded.mimeType}`)
      return {
        file: downloaded.file,
        content: await deps.distill({ buffer, mime: downloaded.mimeType }),
      }
    }
    const parsed = await parseFileContent(buffer, downloaded.mimeType, downloaded.file.name)
    return { file: downloaded.file, content: parsed.text }
  })

  let timer: ReturnType<typeof setInterval> | undefined
  let running = false

  async function processJob(job: GDriveEnrichmentJob): Promise<void> {
    // Scope may change after either a lazy read or an offline bundle queued
    // this version. No queued path may become a side door into out-of-scope
    // Drive content or derivatives.
    const readPolicy = await getGDriveCatalogReadPolicy({
      workspaceId: job.workspaceId,
      connectorInstanceId: job.connectorInstanceId,
      externalFileId: job.externalFileId,
    })
    if (!readPolicy.allowed) {
      await markSuperseded(job.id)
      return
    }

    if (job.mode === 'offline_bundle') {
      if (!job.prefilledPayload) throw new Error('Offline Drive enrichment payload is missing')
      const artifactText = renderOfflineGDriveEnrichment(job.prefilledPayload)
      const artifactFileId = await storeArtifact(deps.filesApi, job, artifactText, job.prefilledPayload.summary)
      await index({
        fileId: artifactFileId,
        workspaceId: job.workspaceId,
        text: artifactText,
        actingUserId: job.actingUserId,
      })
      await markDone({ id: job.id, artifactFileId })
      return
    }

    const fetched = await fetchDriveContent(job.connectorInstanceId, job.externalFileId)
    const currentVersion = driveVersion(fetched.file)
    if (!currentVersion) throw new Error('Google Drive did not return a stable file version')
    if (currentVersion !== job.sourceVersion) {
      await enqueueLazy({
        workspaceId: job.workspaceId,
        connectorInstanceId: job.connectorInstanceId,
        actingUserId: job.actingUserId,
        assistantId: job.assistantId,
        externalFileId: fetched.file.id,
        sourceVersion: currentVersion,
        fileName: fetched.file.name,
        mimeType: fetched.file.mimeType,
        modifiedTime: fetched.file.modifiedTime,
        webViewLink: fetched.file.webViewLink,
      })
      await markSuperseded(job.id)
      return
    }

    const sourceText = fetched.content.slice(0, MAX_NATIVE_TEXT_CHARS)
    const artifactText = renderNativeArtifact(job, fetched.file, sourceText)
    const artifactFileId = await storeArtifact(
      deps.filesApi,
      job,
      artifactText,
      `Versioned Google Drive enrichment source for ${fetched.file.name}`,
    )
    await index({
      fileId: artifactFileId,
      workspaceId: job.workspaceId,
      text: artifactText,
      actingUserId: job.actingUserId,
    })

    let sourceEpisodeId: string | null = null
    if (deps.brainIngest && job.assistantId && sourceText.trim()) {
      const result = await deps.brainIngest({
        workspaceId: job.workspaceId,
        userId: job.actingUserId,
        assistantId: job.assistantId,
        content: sourceText,
        occurredAt: fetched.file.modifiedTime ? new Date(fetched.file.modifiedTime) : new Date(),
        sourceLabel: fetched.file.name,
        sensitivity: 'private',
        sourceKind: 'gdrive_file',
        sourceRef: {
          source_kind: 'gdrive_file',
          connector_instance_id: job.connectorInstanceId,
          drive_file_id: job.externalFileId,
          source_version: job.sourceVersion,
          modified_time: fetched.file.modifiedTime ?? null,
          web_view_link: fetched.file.webViewLink ?? null,
          artifact_file_id: artifactFileId,
        },
        contentRef: {
          source_kind: 'gdrive_file',
          file_id: artifactFileId,
          drive_file_id: job.externalFileId,
          source_version: job.sourceVersion,
          text: sourceText.slice(0, CONTENT_REF_MAX_CHARS),
        },
      })
      sourceEpisodeId = result?.episodeId ?? null
    }
    await markDone({ id: job.id, artifactFileId, sourceEpisodeId })
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
          await markFailed(job.id, message).catch(() => ({ retrying: false }))
          console.error(`[gdrive-enrichment-worker] job ${job.id} failed: ${message}`)
        }
      }
    } catch (err) {
      console.error('[gdrive-enrichment-worker] tick error:', err)
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
