// [COMP:api/conversation-visibility] Read-only authentication for the bounded
// receiving owners. Graph/readiness activation belongs to a later successor.
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {currentInstallationAuthenticationSource as previousSource,assertAuthenticationReadOnly as previousReadOnly} from './installation-authentication-8300.mjs'
import {receivingMigrationName,receivingOwnerDeclaration} from './build-conversation-receiving-owners.mjs'

const literal=value=>"'"+value.replaceAll("'","''")+"'"
const sha=value=>createHash('sha256').update(value).digest('hex')
const pin='b4a4b960eb6c887427a93b8a930eca39ec1ad8bef89e73ba1e0df3b34fff31c6'
const prefix='a8300_'
function once(source,before,after){
 if(source.split(before).length!==2)throw Error('receiving_owner_auth_source_changed: '+before.slice(0,90))
 return source.replace(before,()=>after)
}
function section(source,name){
 const start='-- BEGIN REVIEWED CONVERSATION '+name+'\n',end='-- END REVIEWED CONVERSATION '+name
 if(source.split(start).length!==2||source.split(end).length!==2)throw Error('receiving_owner_auth_manifest_changed')
 return source.slice(source.indexOf(start)+start.length,source.indexOf(end))
}
function reference(definition,name){
 return definition.replace(/^CREATE(?: OR REPLACE)? FUNCTION (?:public\.)?[a-z_0-9]+/,'CREATE FUNCTION pg_temp.'+name)
}
export const assertAuthenticationReadOnly=sql=>previousReadOnly(sql.replaceAll('a8301_',prefix))

export async function receivingInstallationSource(migration,{sourceRoot=fileURLToPath(new URL('../../',import.meta.url))}={}){
 const [previous,record]=await Promise.all([previousSource({sourceRoot}),readFile(sourceRoot.replace(/\/$/,'')+'/migrations/8297_conversation_record_admission.sql','utf8')])
 const base=section(record,'RECORD DEFINITIONS'),owners=section(migration,'RECEIVING OWNERS')
 const changed=[...owners.matchAll(/^CREATE OR REPLACE FUNCTION public\.([a-z_0-9]+)\(/gm)].map(match=>match[1])
 if(JSON.stringify(changed)!==JSON.stringify(['withdraw_conversation_record_rows','conversation_record_rows']))
  throw Error('receiving_owner_auth_replacement_roster_changed')
 let sql=previous.sql
 for(const name of changed){
  const previousRef=(prefix+'record_ref_'+name).slice(0,63)
  sql=once(sql,literal(reference(receivingOwnerDeclaration(base,name),previousRef)),literal(reference(receivingOwnerDeclaration(owners,name),previousRef)))
 }
 const introduced=[...owners.matchAll(/^CREATE FUNCTION public\.([a-z_0-9]+)\(/gm)].map(match=>match[1])
 if(introduced.length!==5||new Set(introduced).size!==introduced.length||/^GRANT /m.test(owners))throw Error('receiving_owner_auth_member_roster_changed')
 const newRefs=introduced.map(name=>({name,ref:(prefix+'receiving_ref_'+name).slice(0,63)})).map(item=>({
  ...item,ddl:reference(receivingOwnerDeclaration(owners,item.name),item.ref),
 }))
 const proof=`DO $receiving_owner_compile$ BEGIN
 ${newRefs.map(item=>'EXECUTE '+literal(item.ddl)+';').join('\n ')}
END $receiving_owner_compile$;
CREATE TEMP TABLE a8300_receiving_oid(oid oid PRIMARY KEY) ON COMMIT DROP;
DO $receiving_owner_source$
DECLARE member record;actual pg_proc;reviewed pg_proc;
 owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);
BEGIN
 FOR member IN SELECT * FROM (VALUES ${newRefs.map(item=>`(${literal(item.name)},${literal(item.ref)})`).join(',')}) q(name,reference) LOOP
  SELECT * INTO STRICT reviewed FROM pg_proc WHERE pronamespace=pg_my_temp_schema() AND proname=member.reference;
  SELECT * INTO actual FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=member.name AND proargtypes=reviewed.proargtypes;
  IF actual.oid IS NULL OR actual.proowner<>owner_id OR actual.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)]
   OR (to_jsonb(actual)-ARRAY['oid','proname','pronamespace','proacl']) IS DISTINCT FROM
    (to_jsonb(reviewed)-ARRAY['oid','proname','pronamespace','proacl']) THEN
   RAISE EXCEPTION 'conversation_receiving_helper_changed: %',member.name;END IF;
  INSERT INTO pg_temp.a8300_receiving_oid VALUES(actual.oid);
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE oid='public.conversation_envelope_backfill_checkpoint'::regclass AND c.relkind='r'
   AND c.relowner=owner_id AND c.relrowsecurity AND NOT c.relforcerowsecurity
   AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
   AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',owner_id))) WHERE grantee<>owner_id))
  OR (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute WHERE attrelid='public.conversation_envelope_backfill_checkpoint'::regclass
   AND attnum>0 AND NOT attisdropped) IS DISTINCT FROM ARRAY['singleton','after_session_id','complete']::text[]
 THEN RAISE EXCEPTION 'conversation_receiving_backfill_catalog_changed';END IF;
END $receiving_owner_source$;`
 const receipt='SELECT encode(sha256(convert_to((SELECT jsonb_agg(metadata ORDER BY signature COLLATE "C") FROM pg_temp.a8300_publication_expected_current)::text'
 sql=once(sql,receipt,proof+'\n'+receipt)
 const begin=sql.indexOf(receipt),tail=")::text,'UTF8')),'hex') local_digest,"
 sql=sql.slice(0,begin)+once(sql.slice(begin),tail,`)::text||(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid::regprocedure::text COLLATE "C")
  FROM pg_proc p JOIN pg_temp.a8300_receiving_oid r USING(oid))::text,'UTF8')),'hex') local_digest,`)
 sql=once(sql,')::int functions,','+'+newRefs.length+')::int functions,')
 sql=sql.replaceAll(prefix,'a8301_');assertAuthenticationReadOnly(sql)
 const cleanup=(previous.cleanup+`\nDO $receiving_ref_cleanup$ DECLARE f record;BEGIN
  FOR f IN SELECT p.oid::regprocedure identity FROM pg_proc p WHERE p.pronamespace=pg_my_temp_schema()
   AND p.proname=ANY(ARRAY[${newRefs.map(item=>literal(item.ref)).join(',')}])
  LOOP EXECUTE 'DROP FUNCTION '||f.identity;END LOOP;
 END $receiving_ref_cleanup$;`).replaceAll(prefix,'a8301_')
 return {...previous,sql,cleanup,functions:previous.functions+newRefs.length,sourceDigest:sha(migration),migrationSha:sha(migration)}
}
export async function currentInstallationAuthenticationSource({sourceRoot=fileURLToPath(new URL('../../',import.meta.url))}={}){
 const migration=await readFile(sourceRoot.replace(/\/$/,'')+'/migrations/'+receivingMigrationName,'utf8')
 if(sha(migration)!==pin)throw Error('installation_source_migration_changed')
 return receivingInstallationSource(migration,{sourceRoot})
}
export async function authenticateConversationInstallation(client,options){
 if(client?.getTransactionStatus?.()!=='I')throw Error('installation_authentication_requires_idle_owner')
 const source=await currentInstallationAuthenticationSource(options)
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
 try{
  const result=await client.query(source.sql),row=(Array.isArray(result)?result.at(-1):result)?.rows?.[0]
  if(!row||row.functions!==source.functions||!/^[a-f0-9]{64}$/.test(row.local_digest)||typeof row.witness_current!=='boolean')
   throw Error('installation_authentication_receipt_malformed')
  await client.query(source.cleanup);await client.query('COMMIT')
  return Object.freeze({format:1,sourceDefinitionDigest:source.sourceDigest,functions:row.functions,
   localContractDigest:row.local_digest,witnessCurrent:row.witness_current})
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}
}
