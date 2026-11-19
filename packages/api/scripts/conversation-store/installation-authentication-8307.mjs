// [COMP:api/conversation-visibility] Authenticated Project floor and retry epoch.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  currentInstallationAuthenticationSource as previousSource,
  assertAuthenticationReadOnly as previousReadOnly,
} from './installation-authentication-8306.mjs'
import { recordFloorMigrationName, reviewedRecordFloorDeclarations } from './build-conversation-record-floor.mjs'
import { fusedRecordFloorChanges, recordFloorChanges, recordFloorRenderer } from './conversation-record-floor.mjs'

const prefix = 'a8306_'
const installedPrefix = 'a8307_'
const renderer = prefix + 'conversion_source_body'
const previousRenderer = prefix + 'record_floor_pred_source_body'
const literal = value => "'" + value.replaceAll("'", "''") + "'"
const sha = value => createHash('sha256').update(value).digest('hex')
function replace(source, before, after, count=1) {
  if (source.split(before).length !== count + 1) throw Error('record_floor_authentication_source_changed: ' + before.slice(0,80))
  return source.replaceAll(before, () => after)
}
export const assertAuthenticationReadOnly = sql => previousReadOnly(sql.replaceAll(installedPrefix,prefix))

export async function recordFloorInstallationSource(migration, options) {
  const [previous, declarations] = await Promise.all([previousSource(options), reviewedRecordFloorDeclarations()])
  const startMarker = '-- BEGIN REVIEWED CONVERSATION RECORD FLOOR\n'
  const endMarker = '-- END REVIEWED CONVERSATION RECORD FLOOR'
  const compiled = declarations.map(rule => rule.successor.replace('CREATE FUNCTION ', 'CREATE OR REPLACE FUNCTION ')).join('\n')
  if (migration.split(startMarker).length !== 2 || migration.split(endMarker).length !== 2
    || !migration.includes(startMarker+compiled+'\n'+endMarker))
    throw Error('record_floor_authentication_declaration_changed')

  let sql = previous.sql
  const originalRenderer = `CREATE FUNCTION pg_temp.${renderer}(routine text,parts jsonb,successor boolean)`
  sql = replace(sql, originalRenderer, originalRenderer.replace(renderer, previousRenderer))
  const marker = 'END $record_conversion_renderer$;'
  sql = replace(sql, marker, marker + '\n' + recordFloorRenderer(renderer, previousRenderer))
  const originalBodyCheck = "(expected->>'signature') NOT IN("
  sql = replace(sql, originalBodyCheck, originalBodyCheck + Object.keys(recordFloorChanges).map(literal).join(',') + ',')

  for (const rule of declarations) {
    const path = (prefix + 'record_ref_' + rule.name).slice(0,63)
    const reference = definition => definition.replace(/^CREATE(?: OR REPLACE)? FUNCTION public\.[a-z_0-9]+/,'CREATE FUNCTION pg_temp.' + path)
    sql = replace(sql,literal(reference(rule.original)),literal(reference(rule.successor)))
  }
  const fusedMarker = `EXECUTE format('CREATE FUNCTION pg_temp.${prefix}f_r_fused_l_message_snapshot(`
  const first = sql.indexOf(fusedMarker)
  const last = sql.indexOf(" EXECUTE format('CREATE FUNCTION pg_temp.",first + fusedMarker.length)
  if (first < 0 || last < 0 || sql.split(fusedMarker).length !== 2) throw Error('record_floor_fused_reference_changed')
  let fused = sql.slice(first,last)
  for (const [before,after,count] of fusedRecordFloorChanges) {
    const quoteBody = text => text.replaceAll("'", "''")
    fused = replace(fused,quoteBody(before),quoteBody(after),count)
  }
  sql = sql.slice(0,first)+fused+sql.slice(last)
  // The fused guard's earlier canonical roster pins its original peer
  // definitions. Verify those digests from predecessor source and verify the
  // current peer bodies through the successor renderer above.
  const predicate = sql.indexOf("WHERE p.oid IS NULL OR encode(sha256(convert_to(regexp_replace(regexp_replace(CASE WHEN x.signature=")
  if (predicate<0) throw Error('record_floor_fused_canonical_guard_changed')
  const tail = '  ELSE p.prosrc END,'
  const after = sql.indexOf(tail,predicate)
  if (after<0) throw Error('record_floor_fused_canonical_selector_changed')
  sql = sql.slice(0,after)+`  WHEN x.signature IN(${Object.keys(recordFloorChanges).map(literal).join(',')}) THEN
  pg_temp.${previousRenderer}(x.signature,(SELECT parts FROM pg_temp.${prefix}publication_successor_templates WHERE signature=x.signature),true)
`+sql.slice(after)
  sql = sql.replaceAll(prefix,installedPrefix)
  assertAuthenticationReadOnly(sql)
  const cleanup = (previous.cleanup + `\nDROP FUNCTION pg_temp.${previousRenderer}(text,jsonb,boolean);`).replaceAll(prefix,installedPrefix)
  return { ...previous, sql, cleanup, sourceDigest: sha(migration), migrationSha: sha(migration) }
}

// The supported head is checked as immutable before using the compiled profile.
const sourcePin = 'e4b28848c1098f2cf04d78ba52f943ed5f44aae001d286c80d6b1142a80555b8'
export async function currentInstallationAuthenticationSource({sourceRoot=fileURLToPath(new URL('../../',import.meta.url))}={}) {
  const migration=await readFile(sourceRoot.replace(/\/$/,'')+'/migrations/'+recordFloorMigrationName,'utf8')
  if (sha(migration)!==sourcePin) throw Error('installation_source_migration_changed')
  return recordFloorInstallationSource(migration,{sourceRoot})
}

export async function authenticateConversationInstallation(client,options) {
  if(client?.getTransactionStatus?.()!=='I')throw Error('installation_authentication_requires_idle_owner')
  const source=await currentInstallationAuthenticationSource(options)
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
  try {
    const result=await client.query(source.sql),row=(Array.isArray(result)?result.at(-1):result)?.rows?.[0]
    if(!row||row.functions!==source.functions||!/^[a-f0-9]{64}$/.test(row.local_digest)||typeof row.witness_current!=='boolean')
      throw Error('installation_authentication_receipt_malformed')
    await client.query(source.cleanup)
    await client.query('COMMIT')
    return Object.freeze({format:1,sourceDefinitionDigest:source.sourceDigest,functions:row.functions,
      localContractDigest:row.local_digest,witnessCurrent:row.witness_current})
  } catch(error) {
    await client.query('ROLLBACK').catch(()=>{})
    throw error
  }
}
