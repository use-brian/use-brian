import { connectorsStub, connectorInstanceId, binding } from './connector-helper.js'
import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { FilesApi, FilesContext, WorkspaceFile } from '@use-brian/core'
import type { StructuredExtractionJob, StructuredExtractionStore } from '../../db/structured-document-extractions.js'
import { createStructuredExtractionWorker } from '../worker.js'
import { StructuredOcrError } from '../client.js'
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const pdf = Buffer.from('%PDF-synthetic')
const png = new Uint8Array([137,80,78,71,13,10,26,10])
const raw = Buffer.from(JSON.stringify({schema_version:'1.1',generator:'source-records/1.1',status:'unreviewed_extraction',document:{id:'sha256:'+'a'.repeat(64),source_ref:null,source_sha256:'a'.repeat(64),digest_scope:'normalized OCR snapshot, not PDF bytes',pages:[{page:1,width:10,height:10}]},tables:[],records:[],evidence:[],context:[],document_notes:[],coverage:{numeric_candidates:[],unresolved_refs:[]},issues:[],review_context:null,limitations:[],entities:[]}))
function setup(status: StructuredExtractionJob['status'] = 'queued') {
  const job = {id:'49000000-0000-4000-8000-000000000007',userId:'actor',workspaceId:'workspace',sourceFileId:'source',pdfSha256:hash(pdf),context:{connector:binding},status,remoteJobId: status === 'queued' ? null : 'a'.repeat(32),recordsFileId:null,recordsSha256:null,documentId:null,imageFiles:[],pageNumbers:[],archivedBytes:0,errorCode:null,leaseToken:null,leaseExpiresAt:null,createdAt:new Date(),updatedAt:new Date()} as StructuredExtractionJob
  let lost = false
  const update = vi.fn(async (user: string,id: string,token: string,expected: string,patch: Record<string,unknown>) => {
    if (lost || user !== job.userId || id !== job.id || token !== job.leaseToken || expected !== job.status) return null
    Object.assign(job,patch)
    if ('retryMs' in patch || ['completed','failed'].includes(job.status)) job.leaseToken = null
    return {...job}
  })
  const store = {
    claim: vi.fn(async (user: string,token: string) => { if (user !== job.userId || !['queued','submitting','running','archiving'].includes(job.status)) return null; job.leaseToken=token; return {...job} }),
    update,
    fail: vi.fn((u,id,t,s,code) => update(u,id,t,s,{status:'failed',errorCode:code})),
    complete: vi.fn((u,id,t) => update(u,id,t,'archiving',{status:'completed'})),
  } as unknown as StructuredExtractionStore
  const source = {id:'source',userId:null,assistantId:null,workspaceId:'workspace',mime:'application/pdf',sensitivity:'confidential',compartments:['team'],projectIds:['project'],validTo:null,retractedAt:null,supersededBy:null} as WorkspaceFile
  const blobs = new Map<string,{file:WorkspaceFile;bytes:Uint8Array}>([['source',{file:source,bytes:pdf}]])
  const notFound = {ok:false as const,error:{kind:'not_found' as const,reference:'missing'}}
  const files = {
    readBytes:vi.fn(async (_ctx:FilesContext,id:string) => { const value = blobs.get(id); return value ? {ok:true as const,value} : notFound }),
    stat:vi.fn(async (_ctx:FilesContext,path:string) => { const found = [...blobs.values()].find(b => b.file.path === path); return found ? {ok:true as const,value:found.file} : notFound }),
    writeBytes:vi.fn(async (ctx:FilesContext,p:{path:string;bytes:Uint8Array;mime:string;sensitivity:string}) => {
      const file = {...source,id:`out-${blobs.size}`,path:p.path,mime:p.mime,sensitivity:p.sensitivity,compartments:ctx.writeCompartments,projectIds:ctx.writeProjectIds} as WorkspaceFile
      blobs.set(file.id,{file,bytes:p.bytes}); return {ok:true as const,value:file}
    }),
  } as unknown as FilesApi
  const client = {health:vi.fn(),submit:vi.fn(async () => ({id:'a'.repeat(32)})),status:vi.fn(async () => ({status:'completed' as const})),records:vi.fn(async () => raw),image:vi.fn(async () => png)}
  const authorize = vi.fn(async () => ({userId:'actor',workspaceId:'workspace',clearance:'confidential',compartments:['team'],projectIds:['project']} as FilesContext))
  const resolveClient = vi.fn(async () => client)
  const worker = createStructuredExtractionWorker({store,files,resolveClient,authorize})
  return {job,store,files,client,resolveClient,authorize,worker,blobs,loseLease:() => {lost=true},restoreLease:() => {lost=false}}
}
describe('[COMP:api/structured-documents] single-step leased extraction worker', () => {
  it('resolves afresh after authorization for each network step and passes deterministic upload ID', async () => {
    const s = setup()
    s.resolveClient.mockImplementation(async () => { expect(s.authorize).toHaveBeenCalled(); return s.client })
    await s.worker.runOnce('actor')
    expect(s.client.submit).toHaveBeenCalledWith(pdf, 'source.pdf', s.job.id.replaceAll('-', ''))
    await s.worker.runOnce('actor')
    await s.worker.runOnce('actor')
    await s.worker.runOnce('actor')
    expect(s.resolveClient).toHaveBeenCalledTimes(4)
    await s.worker.runOnce('actor')
    expect(s.resolveClient).toHaveBeenCalledTimes(4) // local manifest completion
  })
  it('fails unbound and revoked jobs before remote work, requiring fresh preflight', async () => {
    for (const state of ['queued', 'running', 'archiving'] as const) {
      const s = setup(state); delete s.job.context.connector
      await s.worker.runOnce('actor')
      expect(s.job.errorCode).toBe('new_preflight_required')
      expect(s.resolveClient).not.toHaveBeenCalled()
      const t = setup(state); t.resolveClient.mockRejectedValue(new Error('secret'))
      await t.worker.runOnce('actor')
      expect(t.job.errorCode).toBe('new_preflight_required')
      expect(t.client.submit).not.toHaveBeenCalled(); expect(t.client.status).not.toHaveBeenCalled(); expect(t.client.records).not.toHaveBeenCalled()
    }
  })
  it('does nothing for another actor', async () => { const s=setup(); expect(await s.worker.runOnce('foreign')).toBe(false); expect(s.authorize).not.toHaveBeenCalled() })
  it('persists submitting before POST and remote ID before polling', async () => {
    const s=setup(); s.client.submit.mockImplementation(async () => {expect(s.job.status).toBe('submitting'); return {id:'a'.repeat(32)}})
    await s.worker.runOnce('actor'); expect(s.job.status).toBe('running'); expect(s.client.status).not.toHaveBeenCalled(); expect(s.job.leaseToken).toBeNull()
  })
  it('never resubmits an uncertain reclaimed submitting job', async () => { const s=setup('submitting'); await s.worker.runOnce('actor'); expect(s.job.errorCode).toBe('uncertain_submission'); expect(s.client.submit).not.toHaveBeenCalled() })
  it('busy requeues, uncertain errors fail without exposing text', async () => {
    const s=setup(); s.client.submit.mockRejectedValueOnce(new StructuredOcrError('busy')); await s.worker.runOnce('actor'); expect(s.job.status).toBe('queued')
    s.client.submit.mockRejectedValueOnce(new Error('private raw response')); await s.worker.runOnce('actor'); expect(s.job.errorCode).toBe('uncertain_submission')
  })
  it('rejects changed source before dispatch and before archiving', async () => {
    for (const state of ['queued','archiving'] as const) { const s=setup(state); s.blobs.get('source')!.bytes=Buffer.from('%PDF-changed'); await s.worker.runOnce('actor'); expect(s.job.errorCode).toBe('source_changed'); expect(s.client.submit).not.toHaveBeenCalled(); expect(s.client.records).not.toHaveBeenCalled() }
  })
  it('rejects private source partitions before dispatch or any archive side effect', async () => {
    for (const state of ['queued','archiving'] as const) {
      for (const partition of [{userId:'actor'},{assistantId:'assistant'},{userId:undefined}]) {
        const s=setup(state); Object.assign(s.blobs.get('source')!.file,partition)
        await s.worker.runOnce('actor')
        expect(s.job.errorCode).toBe('private_source_unsupported')
        expect(s.client.submit).not.toHaveBeenCalled(); expect(s.client.records).not.toHaveBeenCalled(); expect(s.client.image).not.toHaveBeenCalled()
        expect(s.files.stat).not.toHaveBeenCalled(); expect(s.files.writeBytes).not.toHaveBeenCalled(); expect(s.store.complete).not.toHaveBeenCalled()
      }
    }
  })
  it('rejects revoked or passthrough authorization', async () => {
    const s=setup(); s.authorize.mockResolvedValueOnce({userId:'actor',workspaceId:'workspace'}); await s.worker.runOnce('actor'); expect(s.job.errorCode).toBe('access_denied'); expect(s.client.submit).not.toHaveBeenCalled()
  })
  it('accepts explicit universe grants but rejects undefined and inherited grants', async () => {
    const s=setup(); s.authorize.mockResolvedValueOnce({userId:'actor',workspaceId:'workspace',clearance:'confidential',compartments:null,projectIds:null})
    await s.worker.runOnce('actor'); expect(s.job.status).toBe('running'); expect(s.client.submit).toHaveBeenCalledTimes(1)
    for (const grants of [{compartments:undefined,projectIds:null},Object.create({compartments:null,projectIds:null})]) {
      const t=setup(); const ctx=Object.assign(Object.create(Object.getPrototypeOf(grants)),grants,{userId:'actor',workspaceId:'workspace',clearance:'confidential'})
      t.authorize.mockResolvedValueOnce(ctx); await t.worker.runOnce('actor'); expect(t.job.errorCode).toBe('access_denied'); expect(t.client.submit).not.toHaveBeenCalled()
    }
  })
  it('archives exact records then images one step at a time; only completes durable manifest', async () => {
    const s=setup('archiving'); await s.worker.runOnce('actor'); expect(s.job.recordsFileId).toBeTruthy(); expect(s.job.status).toBe('archiving'); expect(s.client.image).not.toHaveBeenCalled()
    await s.worker.runOnce('actor'); expect(s.job.imageFiles).toHaveLength(1); expect(s.job.status).toBe('archiving')
    const output=s.blobs.get(s.job.recordsFileId!)!; expect(output.file.compartments).toEqual(['team']); expect(output.file.projectIds).toEqual(['project']); expect(output.file.sensitivity).toBe('confidential'); expect(output.bytes).toEqual(raw)
    await s.worker.runOnce('actor'); expect(s.job.status).toBe('completed'); expect(s.client.records).toHaveBeenCalledTimes(1); expect(s.client.image).toHaveBeenCalledTimes(1)
  })
  it.each(['records', 'image'] as const)('retries busy %s with checkpoints intact and completes without resubmission', async operation => {
    const s = setup('archiving')
    if (operation === 'image') await s.worker.runOnce('actor')
    const progress = () => ({ status: s.job.status, remoteJobId: s.job.remoteJobId,
      recordsFileId: s.job.recordsFileId, recordsSha256: s.job.recordsSha256, documentId: s.job.documentId,
      pageNumbers: s.job.pageNumbers, imageFiles: s.job.imageFiles, archivedBytes: s.job.archivedBytes,
      createdAt: s.job.createdAt, errorCode: s.job.errorCode })
    const before = structuredClone(progress())
    const writes = vi.mocked(s.files.writeBytes).mock.calls.length
    s.client[operation].mockRejectedValueOnce(new StructuredOcrError('busy'))
    expect(await s.worker.runOnce('actor')).toBe(true)
    expect(progress()).toEqual(before)
    expect(s.job.leaseToken).toBeNull()
    expect(s.store.update).toHaveBeenLastCalledWith('actor', s.job.id, expect.any(String), 'archiving', { retryMs: 5_000 })
    expect(s.files.writeBytes).toHaveBeenCalledTimes(writes)
    expect(s.store.fail).not.toHaveBeenCalled()
    for (let n = 0; n < (operation === 'records' ? 3 : 2); n++) await s.worker.runOnce('actor')
    expect(s.job.status).toBe('completed')
    expect(s.job.errorCode).toBeNull()
    expect(s.client.submit).not.toHaveBeenCalled()
    expect(s.client.status).not.toHaveBeenCalled()
  })
  it('retains earlier image checkpoints when a later page is busy', async () => {
    const s = setup('archiving')
    const records = JSON.parse(raw.toString())
    records.document.pages.push({ page: 2, width: 10, height: 10 })
    s.client.records.mockResolvedValueOnce(Buffer.from(JSON.stringify(records)))
    await s.worker.runOnce('actor'); await s.worker.runOnce('actor')
    const images = structuredClone(s.job.imageFiles), bytes = s.job.archivedBytes
    s.client.image.mockRejectedValueOnce(new StructuredOcrError('busy'))
    await s.worker.runOnce('actor')
    expect(s.job.imageFiles).toEqual(images)
    expect(s.job.archivedBytes).toBe(bytes)
    await s.worker.runOnce('actor'); await s.worker.runOnce('actor')
    expect(s.job.status).toBe('completed')
    expect(s.job.errorCode).toBeNull()
    expect(s.client.records).toHaveBeenCalledTimes(1)
    expect(s.client.image).toHaveBeenCalledTimes(3)
    expect(s.files.writeBytes).toHaveBeenCalledTimes(3)
    expect(s.client.submit).not.toHaveBeenCalled()
  })
  it.each(['records', 'image'] as const)('expires busy %s retries 24 hours from preflight, not last progress', async operation => {
    vi.useFakeTimers()
    try {
      const s = setup('archiving')
      s.job.createdAt = new Date(Date.now() - 24 * 60 * 60 * 1000 + 1)
      if (operation === 'image') await s.worker.runOnce('actor')
      s.client[operation].mockRejectedValue(new StructuredOcrError('busy'))
      await s.worker.runOnce('actor')
      expect(s.job.status).toBe('archiving')
      expect(s.job.errorCode).toBeNull()
      await vi.advanceTimersByTimeAsync(5_000)
      await s.worker.runOnce('actor')
      expect(s.job.status).toBe('failed')
      expect(s.job.errorCode).toBe('archive_busy_expired')
      expect(s.job.leaseToken).toBeNull()
      expect(s.client.submit).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
  it('does not fail or overwrite a job when the busy retry checkpoint loses its lease', async () => {
    const s = setup('archiving')
    s.client.records.mockImplementationOnce(async () => { s.loseLease(); throw new StructuredOcrError('busy') })
    await expect(s.worker.runOnce('actor')).resolves.toBe(true)
    expect(s.job.status).toBe('archiving')
    expect(s.job.errorCode).toBeNull()
    expect(s.store.fail).not.toHaveBeenCalled()
    expect(s.files.writeBytes).not.toHaveBeenCalled()
    expect(s.store.complete).not.toHaveBeenCalled()
  })
  it.each(['records', 'image'] as const)('still fails nonbusy %s errors without retry or resubmission', async operation => {
    const s = setup('archiving')
    if (operation === 'image') await s.worker.runOnce('actor')
    s.client[operation].mockRejectedValueOnce(new StructuredOcrError('invalid_response'))
    await s.worker.runOnce('actor')
    expect(s.job.status).toBe('failed')
    expect(s.job.errorCode).toBe('remote_unavailable')
    expect(s.job.leaseToken).toBeNull()
    expect(s.client.submit).not.toHaveBeenCalled()
  })
  it('does not falsely complete if an archived image disappears', async () => {
    const s=setup('archiving'); await s.worker.runOnce('actor'); await s.worker.runOnce('actor'); s.blobs.delete(s.job.imageFiles[0].fileId); await s.worker.runOnce('actor'); expect(s.job.status).toBe('failed'); expect(s.store.complete).not.toHaveBeenCalled()
  })
  it('recovers a file persisted before checkpoint using deterministic stat/hash lookup', async () => {
    const s=setup('archiving'); await s.worker.runOnce('actor'); const id=s.job.recordsFileId
    Object.assign(s.job,{recordsFileId:null,recordsSha256:null,documentId:null,pageNumbers:[],archivedBytes:0})
    await s.worker.runOnce('actor'); expect(s.job.recordsFileId).toBe(id); expect(s.files.writeBytes).toHaveBeenCalledTimes(1)
  })
  it('fences archive writes after a network step loses its lease', async () => {
    const s=setup('archiving'); s.client.records.mockImplementationOnce(async () => { s.loseLease(); return raw }); await s.worker.runOnce('actor'); expect(s.files.writeBytes).not.toHaveBeenCalled(); expect(s.store.complete).not.toHaveBeenCalled()
  })
  it('bounds total archive size and rejects malformed records', async () => {
    const s=setup('archiving'); await s.worker.runOnce('actor'); s.job.archivedBytes=128*1024*1024
    await s.worker.runOnce('actor'); expect(s.job.errorCode).toBe('archive_too_large'); expect(s.files.writeBytes).toHaveBeenCalledTimes(1)
    const t=setup('archiving'); t.client.records.mockResolvedValueOnce(Buffer.from('{}')); await t.worker.runOnce('actor'); expect(t.job.status).toBe('failed'); expect(t.files.writeBytes).not.toHaveBeenCalled()
  })
  it('releases pending polls with delay rather than looping', async () => {
    const s=setup('running'); s.client.status.mockResolvedValueOnce({status:'running'} as never)
    await s.worker.runOnce('actor'); expect(s.job.status).toBe('running'); expect(s.job.leaseToken).toBeNull(); expect(s.client.status).toHaveBeenCalledTimes(1); expect(s.client.records).not.toHaveBeenCalled()
  })
  it('fails visibly on file quota and image size limits', async () => {
    const s=setup('archiving'); vi.mocked(s.files.writeBytes).mockResolvedValueOnce({ok:false,error:{kind:'quota_exceeded',currentBytes:1,limitBytes:1,attemptedBytes:raw.length}}); await s.worker.runOnce('actor'); expect(s.job.errorCode).toBe('file_quota_exceeded')
    const t=setup('archiving'); await t.worker.runOnce('actor'); t.client.image.mockResolvedValueOnce(new Uint8Array(20*1024*1024+1)); await t.worker.runOnce('actor'); expect(t.job.errorCode).toBe('invalid_image')
  })
})
