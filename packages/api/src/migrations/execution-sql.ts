import { createHash } from 'node:crypto'

/** Executable-only optimization; historical SQL and all contract checks stay intact.
 * [COMP:api/migration-execution-sql]
 */
const reviewed: Readonly<Record<string, readonly [string, number]>> = {
  '8188_native_turn_shared_publication.sql': ['b374051b82a095f5ed4e7d9a1c78f8da0d4107c03deba3f9891e2bfcfdb02e65', 1],
  '8196_native_turn_annotation_publication.sql': ['45d10e796082730586ba2969a42c0e8d57c0847beca1cff12f9884b308a27a38', 2],
  '8197_native_turn_query_acquisition.sql': ['8a095b513ef136566807c14d505960e2385a24c7c350e58a4098e7e77bf711b6', 2],
  '8198_native_turn_graph_representation.sql': ['37c7ca00b4a59541256af170e59b63236dedbefeeec1a1572f6492345ff19ced', 2],
  '8199_native_turn_compact_requirements.sql': ['4731e8c3e80e598a4f9a6ca3c8da95bd4b16fb05741e9ef2c882add532ebd6a1', 2],
  '8200_native_turn_page_completion.sql': ['935d621471b4e4cb907fedd32f376697ecbbec30f944693d9c851f35d188aafa', 2],
  '8201_native_turn_publication_cohorts.sql': ['96280b0b9b2252f1bd82cd4580cfda244abfa3d98d6e9f734546bb98532a2c07', 2],
  '8204_gradual_memory_learning.sql': ['93ec1fbad733c4d5b3eabf1d156cb8f11fc372bbe70bee1987cbeba3fd62553a', 2],
  '8205_native_memory_unrelated_query_ceilings.sql': ['5148a2e93de503c0942274d01600faca8e7bcb93cbbf891723585540df86b2e9', 2],
  '8229_office_native_reader_contract.sql': ['4387edbd5642286ca277c5bf3f09daa2373e4fbcd8c9caf197713d068b84e328', 2],
  '8234_private_transcript_continuity.sql': ['b8e8cf73ecabac713d42936c1a8a6ced5d83de78bc7014d797079a145d6e344d', 2],
  '8235_office_export_source_reader.sql': ['b884e604bce18970789b1eccb99b1bbb4a579e919e557cea52f534689f4a1850', 2],
  '8236_private_transcript_publication.sql': ['b3c12403a20102374e244650bdaeb3ccee1d0039411a3cc27def2113cdc54957', 2],
  '8242_native_empty_annotation_lookup.sql': ['f1a58c7c3934d351f0a392b97629fe3abdc3073ec4201409154c0cb8ebdb0a3c', 2],
  '8243_active_work_recording_native_proof.sql': ['e7e126dd6fa0f1d6259474dd9c247ab49d94fc4595565e25e883d5c1fe445949', 2],
  '8245_native_current_field_planning.sql': ['f5299318ec052cec600a6d9e2901ed2ab3459f1119722380ca89591e517cb7a6', 2],
  '8246_native_private_memory_empty_domain.sql': ['439f8d2b932d73d47603a874d3b3b02b8c29de801e8aab0c995c65a4d0d4fd3d', 2],
}

const callers = 'FOR caller IN SELECT p.oid,p.prosrc FROM pg_proc p'
const update = 'EXECUTE replace(pg_get_functiondef(caller.oid),caller.prosrc,body);'

export function toMigrationExecutionSql(sql: string, file: string): string {
  const expected = reviewed[file]
  if (!expected) return sql
  if (createHash('sha256').update(sql).digest('hex') !== expected[0]) {
    throw new Error(`${file}: historical migration content changed; refusing execution adapter`)
  }
  let blocks = 0
  const result = sql.replace(/^DO (\$[a-z_]+\$)([\s\S]*?)\1;/gm, (original, tag: string, block: string) => {
    if (!block.includes(callers)) return original
    if (block.split(callers).length !== 2 || block.split(update).length !== 2) {
      throw new Error(`${file}: unexpected migration pin propagation block`)
    }
    blocks++
    // Each reviewed block changes function bodies only through this EXECUTE.
    // Keep candidates outside public too: an unknown pin consumer must still fail.
    let body = block.replace(callers,
      'FOR caller IN SELECT p.oid,p.prosrc FROM pg_temp.migration_pin_candidates p')
    body = body.replace(update, `${update} UPDATE pg_temp.migration_pin_candidates SET prosrc=body WHERE oid=caller.oid;`)
    // Retain the exact quoted-body predicate behind an indexable necessary filter.
    body = body.replaceAll('position(previous.quoted_body IN p.prosrc)>0',
      "(p.prosrc LIKE '%'||replace(replace(replace(previous.quoted_body,chr(92),chr(92)||chr(92)),'%',chr(92)||'%'),'_',chr(92)||'_')||'%' AND position(previous.quoted_body IN p.prosrc)>0)")
    for (const field of ['fingerprint', 'body_hash']) {
      body = body.replaceAll(`position(previous.${field} IN p.prosrc)>0`, `p.prosrc LIKE '%'||previous.${field}||'%'`)
    }
    return `CREATE TEMP TABLE pg_temp.migration_pin_candidates (
      oid oid PRIMARY KEY, pronamespace oid, prokind "char", prosrc text
    ) ON COMMIT DROP;
    ALTER TABLE pg_temp.migration_pin_candidates ALTER COLUMN prosrc SET STORAGE EXTERNAL;
    INSERT INTO pg_temp.migration_pin_candidates SELECT oid,pronamespace,prokind,prosrc||'' FROM pg_catalog.pg_proc;
    CREATE INDEX ON pg_temp.migration_pin_candidates USING gin (prosrc public.gin_trgm_ops);
    DO ${tag}${body}${tag};
    DROP TABLE pg_temp.migration_pin_candidates;`
  })
  if (blocks !== expected[1]) throw new Error(`${file}: incomplete migration pin propagation adaptation`)
  return result
}
