/** CSV layouts are owned by the source, and staged bytes are private. [COMP:crm/production-import] */
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { FilesByteVersion } from '@use-brian/core/workspace-files/api.js'
import { CrmOperationsError } from '@use-brian/core/crm/operations-types.js'
import { CRM_CSV_PARSER_VERSION, indexCrmCsv, type CrmCsvLayout, type CrmCsvSpan } from '../crm-operations/import-csv.js'
import { query } from './client.js'

export type CrmCsvIndexSource = { workspaceId: string; version: string; byteCount: number } & (
  { sourceId: string; file?: never; rangeReads: false }
  | { sourceId?: never; file: FilesByteVersion['file']; rangeReads: boolean })

type Index = CrmCsvLayout & { id: string }
type Chunk = CrmCsvSpan & { bytes: Buffer | null }

const changedSource = () => new CrmOperationsError('conflict', 'The staged import source changed while its CSV index was being read.')
const processing = () => new CrmOperationsError('conflict', 'The import source is already being indexed. Retry in a moment.', { reason: 'import_processing' })

export function createCrmCsvIndexStore(pool?: Pool) {
  const run = pool ? pool.query.bind(pool) : query
  const identity = (source: CrmCsvIndexSource) => [source.workspaceId, source.file?.id ?? null,
    source.sourceId ?? null, source.version, CRM_CSV_PARSER_VERSION]

  async function find(source: CrmCsvIndexSource): Promise<Index | undefined> {
    const file = source.file?.id
    const result = await run<Omit<Index, 'headers'> & { headers: Buffer }>(`SELECT id, source_hash AS "sourceHash", headers, total_rows AS "totalRows"
      FROM crm_import_csv_indexes WHERE workspace_id=$1 AND ${file ? 'staged_file_id=$2 AND source_id IS NULL' : 'staged_file_id IS NULL AND source_id=$2'}
        AND source_version=$3 AND parser_version=$4 AND claim_token IS NULL`,
    [source.workspaceId, file ?? source.sourceId, source.version, CRM_CSV_PARSER_VERSION])
    const row = result.rows[0]
    return row && { ...row, headers: JSON.parse(row.headers.toString('utf8')) as string[] }
  }

  async function chunk(indexId: string, chunkIndex: number): Promise<Chunk> {
    const result = await run<Chunk>(`SELECT start_byte AS start, end_byte AS "end", chunk_hash AS hash, staged_bytes AS bytes
      FROM crm_import_csv_index_chunks WHERE index_id=$1 AND chunk_index=$2`, [indexId, chunkIndex])
    if (!result.rows[0]) throw changedSource()
    return result.rows[0]
  }

  async function ensure(source: CrmCsvIndexSource, readAll: () => Promise<Buffer>, expectedHash?: string): Promise<Index> {
    const found = await find(source)
    if (found) return found
    const token = randomUUID()
    const claim = await run<{ id: string }>(`WITH privacy AS MATERIALIZED (
        SELECT pg_try_advisory_xact_lock_shared(hashtextextended('crm-privacy-admission:'||$1::uuid::text,0)) AS granted
      ) INSERT INTO crm_import_csv_indexes
      (workspace_id,staged_file_id,source_id,source_version,parser_version,claim_token,claim_expires_at)
      SELECT $1,$2,$3,$4,$5,$6,clock_timestamp()+interval '2 minutes'
      WHERE (SELECT granted FROM privacy) AND (($2::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM workspace_files
          WHERE workspace_id=$1 AND id=$2 AND storage_uri=$7 AND scope_version=$8
            AND valid_to IS NULL AND retracted_at IS NULL AND superseded_by IS NULL FOR SHARE))
        OR ($3::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM crm_import_sources
          WHERE workspace_id=$1 AND id=$3 AND NOT privacy_erased AND source_hash=$4 FOR SHARE)))
      ON CONFLICT (workspace_id,staged_file_id,source_id,source_version,parser_version) DO UPDATE
        SET claim_token=EXCLUDED.claim_token,claim_expires_at=EXCLUDED.claim_expires_at
        WHERE crm_import_csv_indexes.claim_expires_at < clock_timestamp()
      RETURNING id`, [...identity(source), token, source.file?.storageUri ?? null, source.file?.scopeVersion ?? null])
    const id = claim.rows[0]?.id
    if (!id) {
      const published = await find(source)
      if (published) return published
      throw processing()
    }
    try {
      const bytes = await readAll()
      if (bytes.byteLength !== source.byteCount) throw changedSource()
      const { spans, ...layout } = indexCrmCsv(bytes)
      if (expectedHash && expectedHash !== layout.sourceHash) throw changedSource()
      const result = await run<{ id: string }>(`WITH privacy AS MATERIALIZED (
          SELECT pg_try_advisory_xact_lock_shared(hashtextextended('crm-privacy-admission:'||$1::uuid::text,0)) AS granted
        ), live_source AS MATERIALIZED (
          SELECT id FROM crm_import_sources WHERE workspace_id=$1 AND id=$2 AND NOT privacy_erased AND source_hash=$3 FOR SHARE
        ), live_file AS MATERIALIZED (
          SELECT id FROM workspace_files WHERE workspace_id=$1 AND id=$4 AND storage_uri=$5 AND scope_version=$6
            AND valid_to IS NULL AND retracted_at IS NULL AND superseded_by IS NULL FOR SHARE
        ), published AS (
          UPDATE crm_import_csv_indexes SET source_hash=$3,total_rows=$7,headers=$8,claim_token=NULL,claim_expires_at=NULL
          WHERE id=$9 AND claim_token=$10 AND claim_expires_at>clock_timestamp()
            AND (SELECT granted FROM privacy)
            AND (EXISTS (SELECT 1 FROM live_source) OR EXISTS (SELECT 1 FROM live_file)) RETURNING id
        ), saved AS (
          INSERT INTO crm_import_csv_index_chunks(index_id,chunk_index,start_byte,end_byte,chunk_hash,staged_bytes)
          SELECT id,(ordinality-1)::int,start_byte,end_byte,hash,bytes FROM published,
            unnest($11::int[],$12::int[],$13::text[],$14::bytea[]) WITH ORDINALITY AS c(start_byte,end_byte,hash,bytes,ordinality)
          RETURNING index_id
        ) SELECT id FROM published WHERE (SELECT count(*) FROM saved)=$15`, [
        source.workspaceId, source.sourceId ?? null, layout.sourceHash, source.file?.id ?? null, source.file?.storageUri ?? null,
        source.file?.scopeVersion ?? null, layout.totalRows, Buffer.from(JSON.stringify(layout.headers)), id, token,
        spans.map(span => span.start), spans.map(span => span.end), spans.map(span => span.hash),
        spans.map(span => source.rangeReads ? null : bytes.subarray(span.start, span.end)), spans.length,
      ])
      if (!result.rows[0]) throw changedSource()
      return { id, ...layout }
    } catch (error) {
      // A committed publication drops the token. An interrupted caller can only
      // clear its own claim, and an abandoned claim expires automatically.
      await run('DELETE FROM crm_import_csv_indexes WHERE id=$1 AND claim_token=$2', [id, token]).catch(() => undefined)
      throw error
    }
  }

  async function chunks(indexId: string, includeStagedBytes: boolean): Promise<Chunk[]> {
    const result = await run<Chunk>(`SELECT start_byte AS start, end_byte AS "end", chunk_hash AS hash,
      CASE WHEN $2 THEN staged_bytes END AS bytes
      FROM crm_import_csv_index_chunks WHERE index_id=$1 ORDER BY chunk_index`, [indexId, includeStagedBytes])
    return result.rows
  }
  return { ensure, chunk, chunks }
}
