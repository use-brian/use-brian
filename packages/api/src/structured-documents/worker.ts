import { createHash, randomUUID } from 'node:crypto'
import type { FilesApi, FilesContext, WorkspaceFile } from '@use-brian/core'
import type { StructuredExtractionJob, StructuredExtractionStore, ExtractionPatch } from '../db/structured-document-extractions.js'
import { StructuredOcrError, type StructuredOcrClient } from './client.js'
import { ConnectorBindingSchema } from './connector.js'
import { parseSourceRecords } from './records.js'

const MiB = 1024 * 1024
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
class WorkerError extends Error { constructor(readonly code: string) { super(code) } }
function reject(code: string): never { throw new WorkerError(code) }
const union = (...sets: (string[] | undefined)[]) => [...new Set(sets.flatMap(s => s ?? []))]
function resolvedGrant(ctx: FilesContext, key: 'compartments' | 'mutationCompartments' | 'projectIds'): boolean {
  return Object.prototype.hasOwnProperty.call(ctx, key) && (ctx[key] === null || Array.isArray(ctx[key]))
}
const rank = { public: 0, internal: 1, confidential: 2 }

/** One OCR request per invocation. No timers, logs, service URLs or raw records escape. */
export function createStructuredExtractionWorker(options: {
  store: StructuredExtractionStore
  resolveClient: (job: StructuredExtractionJob, ctx: FilesContext) => Promise<StructuredOcrClient>
  files: FilesApi
  /** Revalidate saved principal, source version and current access; never return system passthrough. */
  authorize: (job: StructuredExtractionJob) => Promise<FilesContext>
  leaseMs?: number
  retryMs?: number
}) {
  const { store, files } = options
  const retryMs = options.retryMs ?? 5_000
  return {
    async runOnce(userId: string): Promise<boolean> {
      const token = randomUUID()
      let job = await store.claim(userId, token, options.leaseMs ?? 120_000)
      if (!job) return false
      async function checkpoint(patch: ExtractionPatch) {
        const next = await store.update(userId, job!.id, token, job!.status, patch)
        if (!next) reject('lease_lost')
        job = next
      }
      let assertCurrent: (() => Promise<void>) | undefined
      try {
        if (job.userId !== userId) reject('access_denied')
        if (job.status === 'submitting') reject('uncertain_submission')
        type CurrentSource = { ctx: FilesContext; file: WorkspaceFile; bytes: Uint8Array; writeCtx: FilesContext }
        async function authorizeCurrent(): Promise<CurrentSource> {
          let ctx: FilesContext
          try { ctx = await options.authorize(job!) } catch { reject('access_denied') }
          if (ctx.userId !== userId || ctx.workspaceId !== job!.workspaceId || !ctx.clearance ||
              !resolvedGrant(ctx, 'compartments') || !resolvedGrant(ctx, 'mutationCompartments') || !resolvedGrant(ctx, 'projectIds')) reject('access_denied')
          const source = await files.readBytes(ctx, job!.sourceFileId)
          if (!source.ok) reject('source_unavailable')
          const { file, bytes } = source.value
          // Files writes cannot preserve private user/assistant partitions in this slice.
          // Require explicitly shared source metadata; never archive a broader copy.
          if (file.userId !== null || file.assistantId !== null) reject('private_source_unsupported')
          if (file.id !== job!.sourceFileId || file.workspaceId !== job!.workspaceId || file.validTo || file.retractedAt || file.supersededBy) reject('source_changed')
          if (!Array.isArray(file.compartments ?? []) || !Array.isArray(file.projectIds ?? []) || rank[file.sensitivity] > rank[ctx.clearance] ||
              ctx.compartments !== null && !(file.compartments ?? []).every(value => ctx.compartments!.includes(value)) ||
              ctx.mutationCompartments !== null && !(file.compartments ?? []).every(value => ctx.mutationCompartments!.includes(value)) ||
              ctx.projectIds !== null && !(file.projectIds ?? []).every(value => ctx.projectIds!.includes(value))) reject('access_denied')
          if (sha(bytes) !== job!.pdfSha256) reject('source_changed')
          if (bytes.length > 15 * MiB || file.mime !== 'application/pdf' || Buffer.from(bytes.subarray(0,5)).toString() !== '%PDF-') reject('invalid_pdf')
          return { ctx, file, bytes, writeCtx: { ...ctx,
            writeSensitivity: file.sensitivity,
            writeCompartments: union(ctx.writeCompartments, file.compartments),
            writeProjectIds: union(ctx.writeProjectIds, file.projectIds),
          } }
        }
        let current = await authorizeCurrent()
        async function refresh() { current = await authorizeCurrent(); return current }
        assertCurrent = async () => { await refresh() }
        async function checkpointCurrent(patch: ExtractionPatch) { await refresh(); await checkpoint(patch) }
        function eligible(output: WorkspaceFile, state: CurrentSource = current) {
          if (output.workspaceId !== job!.workspaceId || output.validTo || output.retractedAt || output.supersededBy || rank[output.sensitivity] < rank[state.file.sensitivity] ||
              !state.writeCtx.writeCompartments!.every(c => (output.compartments ?? []).includes(c)) || !state.writeCtx.writeProjectIds!.every(p => (output.projectIds ?? []).includes(p))) reject('archive_scope_mismatch')
        }
        async function readArtifact(id: string, digest: string, limit: number, state: CurrentSource = current) {
          const result = await files.readBytes(state.writeCtx, id)
          if (!result.ok) reject('archive_unavailable')
          eligible(result.value.file, state)
          if (result.value.bytes.length > limit || sha(result.value.bytes) !== digest) reject('archive_changed')
          return result.value.bytes
        }
        async function persist(bytes: Uint8Array, name: string, mime: string) {
          const state = await refresh()
          // Content-addressed deterministic paths recover a committed file after a lost DB checkpoint.
          const digest = sha(bytes)
          const path = `/structured-extractions/${job!.id}/${digest}-${name}`
          const existing = await files.stat(state.writeCtx, path)
          if (existing.ok) {
            await readArtifact(existing.value.id, digest, bytes.length, state)
            return existing.value.id
          }
          if (existing.error.kind !== 'not_found') reject('archive_unavailable')
          await checkpoint({}) // Fence after network and before any durable side effect.
          const result = await files.writeBytes(state.writeCtx, { path, bytes, mime, sensitivity: state.file.sensitivity })
          if (!result.ok) {
            if (result.error.kind === 'conflict') {
              const winner = await files.stat(state.writeCtx,path)
              if (winner.ok) { await readArtifact(winner.value.id,digest,bytes.length,state); return winner.value.id }
            }
            reject(result.error.kind === 'quota_exceeded' ? 'file_quota_exceeded' : 'archive_write_failed')
          }
          eligible(result.value, state)
          // Never trust a success envelope alone as proof that evidence bytes are durable.
          await readArtifact(result.value.id,digest,bytes.length,state)
          return result.value.id
        }
        async function networkClient() {
          if (!ConnectorBindingSchema.safeParse(job!.context.connector).success) reject('new_preflight_required')
          const state = await refresh()
          try { return await options.resolveClient(job!, state.ctx) }
          catch { reject('new_preflight_required') }
        }
        if (job.status === 'queued') {
          if (!ConnectorBindingSchema.safeParse(job.context.connector).success) reject('new_preflight_required')
          await checkpointCurrent({status:'submitting'})
          const client = await networkClient()
          try {
            const remote = await client.submit(current.bytes,'source.pdf',job.id.replaceAll('-', ''))
            await refresh()
            await checkpoint({status:'running',remoteJobId:remote.id,retryMs})
          } catch (error) {
            if (error instanceof StructuredOcrError && error.code === 'busy') await checkpointCurrent({status:'queued',retryMs})
            else throw new WorkerError('uncertain_submission')
          }
          return true
        }
        if (!job.remoteJobId) reject('missing_remote_job')
        if (job.status === 'running') {
          const remote = await (await networkClient()).status(job.remoteJobId)
          await refresh()
          if (remote.status === 'failed') reject('remote_failed')
          await checkpoint({status: remote.status === 'completed' ? 'archiving' : 'running',retryMs: remote.status === 'completed' ? 0 : retryMs})
          return true
        }
        if (job.status !== 'archiving') reject('invalid_state')
        if (!job.recordsFileId) {
          const raw = await (await networkClient()).records(job.remoteJobId)
          await refresh()
          if (raw.length > 32 * MiB) reject('records_too_large')
          const records = parseSourceRecords(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)))
          const pages = records.document.pages.map(p => p.page)
          if (!pages.length || pages.length > 10 || new Set(pages).size !== pages.length || pages.some(p => p < 1 || p > 10)) reject('invalid_pages')
          const id = await persist(raw,'records.json','application/json')
          await checkpointCurrent({recordsFileId:id,recordsSha256:sha(raw),documentId:records.document.id,pageNumbers:pages,archivedBytes:raw.length,retryMs:0})
          return true
        }
        if (!job.recordsSha256 || !job.documentId || !job.pageNumbers.length) reject('invalid_manifest')
        await refresh()
        const recordsBytes = await readArtifact(job.recordsFileId,job.recordsSha256,32 * MiB)
        const parsed = parseSourceRecords(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(recordsBytes)))
        if (parsed.document.id !== job.documentId || JSON.stringify(parsed.document.pages.map(p => p.page)) !== JSON.stringify(job.pageNumbers)) reject('invalid_manifest')
        if (new Set(job.imageFiles.map(i => i.page)).size !== job.imageFiles.length || job.imageFiles.some(i => !job!.pageNumbers.includes(i.page))) reject('invalid_manifest')
        const missing = job.pageNumbers.find(page => !job!.imageFiles.some(i => i.page === page))
        if (missing !== undefined) {
          const image = await (await networkClient()).image(job.remoteJobId,missing)
          await refresh()
          if (image.length > 20 * MiB || ![137,80,78,71,13,10,26,10].every((v,i) => image[i] === v)) reject('invalid_image')
          if (job.archivedBytes + image.length > 128 * MiB) reject('archive_too_large')
          const id = await persist(image,`page-${missing}.png`,'image/png')
          await checkpointCurrent({imageFiles:[...job.imageFiles,{page:missing,fileId:id,sha256:sha(image),sizeBytes:image.length}],archivedBytes:job.archivedBytes+image.length,retryMs:0})
          return true
        }
        let total = recordsBytes.length
        for (const image of job.imageFiles) {
          const saved = await readArtifact(image.fileId,image.sha256,20 * MiB)
          if (saved.length !== image.sizeBytes) reject('invalid_manifest')
          total += saved.length
        }
        if (total > 128 * MiB || total !== job.archivedBytes || job.imageFiles.length !== job.pageNumbers.length) reject('invalid_manifest')
        await refresh()
        await store.complete(userId,job.id,token)
      } catch (error) {
        if (job.status === 'archiving' && error instanceof StructuredOcrError && error.code === 'busy') {
          // The lab's global operation slot may be occupied by another job.
          // Retain every archive checkpoint; never submit the source again.
          if (Date.now() - job.createdAt.getTime() >= 24 * 60 * 60 * 1000) {
            error = new WorkerError('archive_busy_expired')
          } else {
            try {
              if (!assertCurrent) reject('access_denied')
              await assertCurrent()
              await checkpoint({ retryMs: 5_000 })
              return true
            } catch (retryError) {
              // In particular, a lost lease must not fail another worker's job.
              error = retryError
            }
          }
        }
        const code = error instanceof WorkerError ? error.code : error instanceof StructuredOcrError ? 'remote_unavailable' : 'extraction_failed'
        if (code !== 'lease_lost') await store.fail(userId,job!.id,token,job!.status,code)
      }
      return true
    },
  }
}
