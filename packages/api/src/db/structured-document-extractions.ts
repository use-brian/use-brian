import { defaultOfficeDbQuery, type OfficeDbQuery } from './office-artifacts.js'

export type StructuredExtractionStatus = 'prepared' | 'queued' | 'submitting' | 'running' | 'archiving' | 'completed' | 'failed' | 'cancelled'
export type ExtractionImageFile = { page: number; fileId: string; sha256: string; sizeBytes: number }
export type StructuredExtractionJob = {
  id: string; userId: string; workspaceId: string; sourceFileId: string; pdfSha256: string
  context: Record<string, unknown>; status: StructuredExtractionStatus; remoteJobId: string | null
  recordsFileId: string | null; recordsSha256: string | null; documentId: string | null
  imageFiles: ExtractionImageFile[]; pageNumbers: number[]; archivedBytes: number
  errorCode: string | null; leaseToken: string | null; leaseExpiresAt: Date | null
  createdAt: Date; updatedAt: Date
}
export type ExtractionPatch = Partial<Pick<StructuredExtractionJob, 'status' | 'remoteJobId' | 'recordsFileId' | 'recordsSha256' | 'documentId' | 'imageFiles' | 'pageNumbers' | 'archivedBytes' | 'errorCode'>> & { retryMs?: number }
const fields = { id: 'id', userId: 'user_id', workspaceId: 'workspace_id', sourceFileId: 'source_file_id', pdfSha256: 'pdf_sha256', context: 'context', status: 'status', remoteJobId: 'remote_job_id', recordsFileId: 'records_file_id', recordsSha256: 'records_sha256', documentId: 'document_id', imageFiles: 'image_files', pageNumbers: 'page_numbers', archivedBytes: 'archived_bytes', errorCode: 'error_code', leaseToken: 'lease_token', leaseExpiresAt: 'lease_expires_at', createdAt: 'created_at', updatedAt: 'updated_at' }
const columns = Object.entries(fields).map(([key, value]) => `j.${value} AS "${key}"`).join(', ')
const active = ['queued','submitting','running','archiving']
const transitions: Record<string, string[]> = { queued: ['queued','submitting','failed','cancelled'], submitting: ['queued','running','failed','cancelled'], running: ['running','archiving','failed','cancelled'], archiving: ['archiving','completed','failed','cancelled'] }
function boundedMs(value: number) { if (!Number.isSafeInteger(value) || value < 0 || value > 3_600_000) throw new Error('invalid_delay') }
export function createStructuredExtractionStore(db: OfficeDbQuery = defaultOfficeDbQuery) {
  async function update(userId: string, id: string, token: string, expectedStatus: StructuredExtractionStatus, patch: ExtractionPatch): Promise<StructuredExtractionJob | null> {
    if (!active.includes(expectedStatus) || (patch.status && !transitions[expectedStatus]?.includes(patch.status))) throw new Error('invalid_transition')
    const params: unknown[] = [userId,id,token,expectedStatus]
    const sets = ['updated_at=now()']
    for (const [key,value] of Object.entries(patch)) {
      if (key === 'retryMs') continue
      if (!['status','remoteJobId','recordsFileId','recordsSha256','documentId','imageFiles','pageNumbers','archivedBytes','errorCode'].includes(key)) throw new Error('invalid_patch')
      const json = key === 'imageFiles' || key === 'pageNumbers'
      params.push(json ? JSON.stringify(value) : value)
      sets.push(`${fields[key as keyof typeof fields]}=$${params.length}${json ? '::jsonb' : ''}`)
    }
    if (patch.retryMs !== undefined) {
      boundedMs(patch.retryMs); params.push(patch.retryMs)
      sets.push(`next_attempt_at=now()+($${params.length} * interval '1 millisecond')`)
    }
    if (patch.retryMs !== undefined || ['completed','failed','cancelled'].includes(patch.status ?? '')) sets.push('lease_token=NULL','lease_expires_at=NULL')
    return (await db<StructuredExtractionJob>(userId, `UPDATE structured_document_extractions j SET ${sets.join(',')} WHERE user_id=$1 AND id=$2 AND lease_token=$3 AND status=$4 AND lease_expires_at>now() RETURNING ${columns}`, params)).rows[0] ?? null
  }
  return {
    async prepare(input: { userId: string; workspaceId: string; sourceFileId: string; pdfSha256: string; context: Record<string,unknown> }): Promise<StructuredExtractionJob> {
      const row = (await db<StructuredExtractionJob>(input.userId, `INSERT INTO structured_document_extractions AS j (user_id,workspace_id,source_file_id,pdf_sha256,context) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING ${columns}`, [input.userId,input.workspaceId,input.sourceFileId,input.pdfSha256,JSON.stringify(input.context)])).rows[0]
      if (!row) throw new Error('extraction_prepare_failed')
      return row
    },
    async get(userId: string, id: string): Promise<StructuredExtractionJob | null> { return (await db<StructuredExtractionJob>(userId, `SELECT ${columns} FROM structured_document_extractions j WHERE user_id=$1 AND id=$2`, [userId,id])).rows[0] ?? null },
    async enqueue(userId: string, id: string): Promise<StructuredExtractionJob | null> {
      return (await db<StructuredExtractionJob>(userId, `UPDATE structured_document_extractions j SET status=CASE WHEN status='prepared' THEN 'queued' ELSE status END, updated_at=now() WHERE user_id=$1 AND id=$2 RETURNING ${columns}`, [userId,id])).rows[0] ?? null
    },
    async claim(userId: string, leaseToken: string, leaseMs: number): Promise<StructuredExtractionJob | null> {
      boundedMs(leaseMs); if (!leaseMs) throw new Error('invalid_delay')
      return (await db<StructuredExtractionJob>(userId, `WITH candidate AS (SELECT id FROM structured_document_extractions WHERE user_id=$1 AND status IN ('queued','submitting','running','archiving') AND next_attempt_at<=now() AND (lease_expires_at IS NULL OR lease_expires_at<=now()) ORDER BY next_attempt_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE structured_document_extractions j SET lease_token=$2,lease_expires_at=now()+($3 * interval '1 millisecond'),updated_at=now() FROM candidate c WHERE j.id=c.id AND j.user_id=$1 RETURNING ${columns}`, [userId,leaseToken,leaseMs])).rows[0] ?? null
    },
    update,
    fail(userId: string,id: string,token: string,status: StructuredExtractionStatus,errorCode: string) { return update(userId,id,token,status,{status:'failed',errorCode}) },
    complete(userId: string,id: string,token: string) { return update(userId,id,token,'archiving',{status:'completed'}) },
  }
}
export type StructuredExtractionStore = ReturnType<typeof createStructuredExtractionStore>
