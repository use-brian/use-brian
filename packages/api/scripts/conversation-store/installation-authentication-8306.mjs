// [COMP:api/conversation-visibility] Exact read-only post-8306 source profile.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  currentInstallationAuthenticationSource as previousSource,
  assertAuthenticationReadOnly as previousReadOnly,
} from './installation-authentication-8301.mjs'
import {
  promptMemoryMigrationName, promptMemoryDefinition, promptMemoryCatalogProof, promptMemorySignature,
} from './build-conversation-prompt-memory.mjs'

const pin = '34837278c15d8f5db8a0ee8bd87b3076923ae5112107dfea4fd6c2b5214586cf'
const prefix = 'a8301_'
const sha = value => createHash('sha256').update(value).digest('hex')
const receipt = `SELECT encode(sha256(convert_to((SELECT jsonb_agg(metadata ORDER BY signature COLLATE "C") FROM pg_temp.${prefix}publication_expected_current)::text`
function once(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('prompt_memory_authentication_source_changed')
  return source.replace(before, () => after)
}

export const assertAuthenticationReadOnly = sql => previousReadOnly(sql.replaceAll('a8306_',prefix))

export async function promptMemoryInstallationSource(migration, {sourceRoot=fileURLToPath(new URL('../../',import.meta.url))}={}) {
  if (sha(migration) !== pin) throw new Error('prompt_memory_installed_source_changed')
  const previous = await previousSource({sourceRoot})
  const proof = promptMemoryCatalogProof(promptMemoryDefinition(migration),prefix)
  let sql = once(previous.sql, receipt, proof+'\n'+receipt)
  const start = sql.indexOf(receipt)
  const suffix = ")::text,'UTF8')),'hex') local_digest,"
  sql = sql.slice(0,start)+once(sql.slice(start),suffix,`)::text||(SELECT to_jsonb(p)::text FROM pg_proc p
   WHERE p.oid='public.${promptMemorySignature}'::regprocedure),'UTF8')),'hex') local_digest,`)
  sql = once(sql,')::int functions,','+1)::int functions,').replaceAll(prefix,'a8306_')
  assertAuthenticationReadOnly(sql)
  return {...previous,sql,cleanup:previous.cleanup.replaceAll(prefix,'a8306_'),
    functions:previous.functions+1,sourceDigest:pin,migrationSha:pin}
}

export async function currentInstallationAuthenticationSource({sourceRoot=fileURLToPath(new URL('../../',import.meta.url))}={}) {
  const migration = await readFile(sourceRoot.replace(/\/$/,'')+'/migrations/'+promptMemoryMigrationName,'utf8')
  return promptMemoryInstallationSource(migration,{sourceRoot})
}

export async function authenticateConversationInstallation(client,options) {
  if (client?.getTransactionStatus?.()!=='I') throw new Error('installation_authentication_requires_idle_owner')
  const source=await currentInstallationAuthenticationSource(options)
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
  try {
    const result=await client.query(source.sql),row=(Array.isArray(result)?result.at(-1):result)?.rows?.[0]
    if(!row||row.functions!==source.functions||!/^[a-f0-9]{64}$/.test(row.local_digest)||typeof row.witness_current!=='boolean')
      throw new Error('installation_authentication_receipt_malformed')
    await client.query(source.cleanup)
    await client.query('COMMIT')
    return Object.freeze({format:1,sourceDefinitionDigest:source.sourceDigest,functions:row.functions,
      localContractDigest:row.local_digest,witnessCurrent:row.witness_current})
  } catch(error) {
    await client.query('ROLLBACK').catch(()=>{})
    throw error
  }
}
