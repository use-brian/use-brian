// [COMP:api/native-turn-frame] Reviewed successor of the 8286 recipe: Page-root successor of the Page adapter (8287).
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {currentInstallationAuthenticationSource as predecessorSource,assertAuthenticationReadOnly as predecessorReadOnly,currentFunctionCount as predecessorCount} from './installation-authentication-8286.mjs'
import {fileURLToPath} from 'node:url'
import {rootsCheckSql,predecessorReferenceLiteral,successorReferenceLiteral} from './page-closure-roots.mjs'
const sha=x=>createHash('sha256').update(x).digest('hex')
const once=(s,n,r)=>{if(s.split(n).length!==2)throw Error('page_roots_auth_source_transform_changed: '+n.slice(0,80));return s.replace(n,()=>r)}
const currentMigrationSha='2ff9c8b66980f573279aa2e01db49bd802e86e53074569bc49717346bce42ff4'
// No member is added or removed: the successor replaces one member's body.
export const currentFunctionCount=predecessorCount
export function assertAuthenticationReadOnly(sql){return predecessorReadOnly(sql.replaceAll('a8287_','a8286_'))}
export async function currentInstallationAuthenticationSource({sourceRoot=fileURLToPath(new URL('../../',import.meta.url))}={}){
 const base=sourceRoot.replace(/\/$/,'')
 const migration=await readFile(base+'/migrations/8287_page_closure_roots.sql');if(sha(migration)!==currentMigrationSha)throw Error('installation_source_migration_changed')
 const source=await predecessorSource({sourceRoot});let sql=source.sql
 // The 8278 member check compiles the member from source text: compile the
 // successor body instead. Every other field, the ACL and the record check stay.
 sql=once(sql,predecessorReferenceLiteral,successorReferenceLiteral)
 const receipt='SELECT encode(sha256(convert_to((SELECT jsonb_agg(metadata ORDER BY signature COLLATE "C") FROM pg_temp.a8286_publication_expected_current)::text'
 sql=once(sql,receipt,rootsCheckSql('a8286_r_')+'\n'+receipt)
 assertAuthenticationReadOnly(sql.replaceAll('a8286_','a8287_'))
 sql=sql.replaceAll('a8286_','a8287_')
 const cleanup=source.cleanup.replaceAll('a8286_','a8287_')
 return{...source,sql,cleanup,sourceDigest:currentMigrationSha,migrationSha:currentMigrationSha}
}
export async function authenticateConversationInstallation(ownerClient,options){
 if(ownerClient?.getTransactionStatus?.()!=='I')throw Error('installation_authentication_requires_idle_owner')
 const source=await currentInstallationAuthenticationSource(options);await ownerClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
 try{
  const results=await ownerClient.query(source.sql),last=Array.isArray(results)?results.at(-1):results,row=last?.rows?.[0]
  if(!row||row.functions!==currentFunctionCount||!/^[a-f0-9]{64}$/.test(row.local_digest)||typeof row.witness_current!=='boolean')throw Error('installation_authentication_receipt_malformed')
  await ownerClient.query(source.cleanup);await ownerClient.query('COMMIT')
  const remaining=(await ownerClient.query("SELECT (SELECT count(*) FROM pg_proc WHERE pronamespace=pg_my_temp_schema() AND left(proname,6)='a8287_')+(SELECT count(*) FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND left(relname,6)='a8287_')+(SELECT count(*) FROM pg_namespace WHERE nspname IN('a8287_conversion_source_reference','a8287_publication_source_reference')) residue")).rows[0]
  if(Number(remaining.residue)!==0)throw Error('installation_authentication_compiler_residue')
  // A stale witness is a slower guard, never an admission: report it, do not repair it here.
  return Object.freeze({format:1,sourceDefinitionDigest:source.sourceDigest,functions:row.functions,localContractDigest:row.local_digest,witnessCurrent:row.witness_current})
 }catch(error){await ownerClient.query('ROLLBACK').catch(()=>{});throw error}
}
