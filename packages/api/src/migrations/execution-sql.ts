import { createHash } from 'node:crypto'
import { pageThreadSourceExecutionSql } from './page-thread-execution.js'

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
  '8247_recording_privacy_ancestry_frontier.sql': ['310375585317824f227fdec661cb68fb6775b152e2ee0baf03bf1dc145f99d15', 2],
  '8248_page_thread_context_authority.sql': ['4f58c737f519fc9a2726c13ae6d04d5c38f1e78973bc841af273e9e4e36ea5e2', 2],
  '8249_telegram_conversation_context.sql': ['30a27fe9683b924d011f2bcaced1d5f4770f86a470841dd1c1d303cdf8da70ea', 2],
  '8250_page_thread_batch_preparation.sql': ['8b41fe1e2704faccc86920a53abec42cf790db663aec7b049c791371062a857c', 2],
  '8251_private_page_thread_source.sql': ['b49871608d903b4a50586bf12063d4fd789cb2f64cbd1fc3f846261169c73b00', 0],
}

const callers = 'FOR caller IN SELECT p.oid,p.prosrc FROM pg_proc p'
const update = 'EXECUTE replace(pg_get_functiondef(caller.oid),caller.prosrc,body);'

/** System-first lookup must not choose the creation schema for an app helper. */
function privatePagePredicateNamespace(sql: string): string {
  for (const prefix of ['CREATE FUNCTION ', 'REVOKE ALL ON FUNCTION ']) {
    const anchor = `${prefix}page_thread_private_source_visible(`
    if (sql.split(anchor).length !== 2) throw new Error('8251: private predicate namespace anchor changed')
    sql = sql.replace(anchor, `${prefix}public.page_thread_private_source_visible(`)
  }
  return sql
}

/** 8246 sealed a generated roster using the author's database collation.
 * Authenticate the same declared members and code while retaining the target
 * database's existing runtime ORDER BY semantics. Never evaluate catalog text.
 */
function privateMemoryGuardEnrollment(sql: string): string {
  const tag = '$private_memory_domain_profile$'
  const start = sql.indexOf(`DO ${tag}`), end = sql.indexOf(`END ${tag};`, start) + `END ${tag};`.length
  if (start < 0 || end < start || sql.indexOf(`DO ${tag}`, start + 1) >= 0) throw new Error('8246: unexpected private Memory enrollment block')
  let block = sql.slice(start, end)
  const once = (before: string, after: string) => {
    if (block.split(before).length !== 2) throw new Error('8246: unexpected private Memory enrollment anchor')
    block = block.replace(before, after)
  }
  const rosters = ['before', 'after'].map(phase => {
    const marker = `$native_guard_${phase}$`, prefix = `guard_${phase} constant text:=${marker}`
    const begin = block.indexOf(prefix), finish = block.indexOf(`${marker};`, begin + prefix.length)
    if (begin < 0 || finish < 0) throw new Error('8246: missing declared native guard roster')
    const declaration = block.slice(begin, finish + marker.length + 1)
    const expression = block.slice(begin + prefix.length, finish), members = [...expression.matchAll(/'([^']*)'/g)].map(match => match[1])
    if (expression !== `ARRAY[${members.map(member => `'${member}'`).join(',')}]::text[]`
      || members.length !== (phase === 'before' ? 148 : 149) || new Set(members).size !== members.length) {
      throw new Error('8246: unexpected declared native guard members')
    }
    once(declaration, `guard_${phase}_members constant text[]:=${expression};\n guard_${phase} text;`)
    return members
  })
  if (rosters[0].includes('application_memory_statement_helpers_current()')
    || !rosters[1].includes('application_memory_statement_helpers_current()')
    || rosters[0].some(member => !rosters[1].includes(member))) throw new Error('8246: unexpected native guard enrollment')
  once("BEGIN\n SELECT relowner INTO STRICT owner_oid", `BEGIN
 IF cardinality(guard_before_members)<>148 OR cardinality(guard_after_members)<>149
  OR (SELECT count(DISTINCT signature) FROM unnest(guard_before_members) signature)<>148
  OR (SELECT count(DISTINCT signature) FROM unnest(guard_after_members) signature)<>149
  OR NOT guard_after_members @> guard_before_members
  OR 'application_memory_statement_helpers_current()'=ANY(guard_before_members)
  OR NOT 'application_memory_statement_helpers_current()'=ANY(guard_after_members)
 THEN RAISE EXCEPTION 'private_memory_profile_declared_roster_changed';END IF;
 SELECT 'ARRAY['||string_agg(quote_literal(signature),',' ORDER BY signature)||']::text[]'
 INTO guard_before FROM unnest(guard_before_members) declared(signature);
 SELECT 'ARRAY['||string_agg(quote_literal(signature),',' ORDER BY signature)||']::text[]'
 INTO guard_after FROM unnest(guard_after_members) declared(signature);
 SELECT relowner INTO STRICT owner_oid`)
  // Same template authentication as immutable 8190. Only the one exact local
  // roster literal is replaced; every other byte remains authenticated.
  const template = '803d9cd34a7c94347e32172c77ea7387d5cb8e642f905ca08f7f18b796451255'
  once("encode(sha256(convert_to(original,'UTF8')),'hex') IS DISTINCT FROM 'd76edcc03ae49ebbe10bebbe198267aeff0837d597085058aaab0a65ab6247a2'",
    `encode(sha256(convert_to(replace(original,guard_before,'__ROSTER__'),'UTF8')),'hex') IS DISTINCT FROM '${template}'`)
  once("encode(sha256(convert_to(successor,'UTF8')),'hex') IS DISTINCT FROM 'bc3189f583bd7ffb8dd3ba24551fb9d677ee3bf64478fd1fb4959d56b161708b'",
    `encode(sha256(convert_to(replace(successor,guard_after,'__ROSTER__'),'UTF8')),'hex') IS DISTINCT FROM '${template}'
  OR (length(successor)-length(replace(successor,guard_after,'')))/length(guard_after)<>1`)
  return sql.slice(0, start) + block + sql.slice(end)
}

export function toMigrationExecutionSql(sql: string, file: string): string {
  const expected = reviewed[file]
  if (!expected) return sql
  if (createHash('sha256').update(sql).digest('hex') !== expected[0]) {
    throw new Error(`${file}: historical migration content changed; refusing execution adapter`)
  }
  const executable = file === '8246_native_private_memory_empty_domain.sql' ? privateMemoryGuardEnrollment(sql)
    : file === '8248_page_thread_context_authority.sql' ? pageThreadSourceExecutionSql(sql)
      : file === '8251_private_page_thread_source.sql' ? privatePagePredicateNamespace(sql) : sql
  let blocks = 0
  const result = executable.replace(/^DO (\$[a-z_]+\$)([\s\S]*?)\1;/gm, (original, tag: string, block: string) => {
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
