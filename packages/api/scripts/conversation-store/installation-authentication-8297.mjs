// [COMP:api/conversation-visibility] Source authentication for the 8297 record owner.
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {currentInstallationAuthenticationSource as previousSource,currentFunctionCount as previousCount,
 assertAuthenticationReadOnly as previousReadOnly} from './installation-authentication-8296.mjs'
import {recordPublicationChanges,recordPublicationRendererSql} from './conversation-record-publication.mjs'

const sha=value=>createHash('sha256').update(value).digest('hex')
const literal=value=>"'"+value.replaceAll("'","''")+"'"
const replaceOnce=(source,before,after)=>{
 if(source.split(before).length!==2)throw Error('conversation_record_auth_source_changed: '+before.slice(0,80))
 return source.replace(before,()=>after)
}
const migrationName='8297_conversation_record_admission.sql'
const currentMigrationSha='c7dde30c0cefe61167be20492cb0df68a587c26352314e3dfab794ded77c4bf7'
const renderer='a8296_conversion_source_body',previousRenderer='a8296_record_pred_source_body'

export function assertAuthenticationReadOnly(sql){return previousReadOnly(sql.replaceAll('a8297_','a8296_'))}

function reviewedSection(sql,name){
 const begin='-- BEGIN REVIEWED CONVERSATION RECORD '+name+'\n',end='-- END REVIEWED CONVERSATION RECORD '+name
 if(sql.split(begin).length!==2||sql.split(end).length!==2)throw Error('conversation_record_auth_sections_changed')
 return sql.slice(sql.indexOf(begin)+begin.length,sql.indexOf(end))
}

/** Compile the exact durable declarations carried by the numbered migration. */
function recordReferences(migration){
 const definitions=reviewedSection(migration,'DEFINITIONS')
 const appGrants=new Set([...`${definitions}\n${reviewedSection(migration,'ACL')}`.matchAll(/^GRANT EXECUTE ON FUNCTION ([^;]+?) TO app_user;/gm)]
  .flatMap(match=>[...match[1].matchAll(/public\.([a-z_][a-z_0-9]*)\(/g)].map(name=>name[1])))
 const routines=[...definitions.matchAll(/^CREATE( OR REPLACE)? FUNCTION public\.([a-z_][a-z_0-9]*)\(((?:(?!^CREATE(?: OR REPLACE)? FUNCTION)[\s\S])*?\bAS\s+(\$[a-z_0-9]*\$))([\s\S]*?)\4;/gm)]
 const declarations=[...definitions.matchAll(/^CREATE(?: OR REPLACE)? FUNCTION public\.([a-z_][a-z_0-9]*)\(/gm)]
 if(routines.length!==declarations.length||new Set(routines.map(match=>match[2])).size!==routines.length
  ||routines.length<40||[...appGrants].some(name=>!routines.some(match=>match[2]===name)))throw Error('conversation_record_reference_declarations_changed')
 const checks=routines.map(([,replacement,name,args,tag,body])=>{
  const reference=`a8296_record_ref_${name}`.slice(0,63)
  return{reference,name,replacement:!!replacement,app:appGrants.has(name),
   definition:`CREATE FUNCTION pg_temp.${reference}(${args}${body}${tag};`}
 })
 if(new Set(checks.map(check=>check.reference)).size!==checks.length)throw Error('conversation_record_reference_collision')
 return {
  size:checks.length,
  sql:`DO $record_reference_compile$ BEGIN
 ${checks.map(check=>'EXECUTE '+literal(check.definition)+';').join('\n ')}
END $record_reference_compile$;
CREATE TEMP TABLE a8296_record_reference_oids(oid oid PRIMARY KEY) ON COMMIT DROP;
DO $record_references$
DECLARE item record;actual pg_proc;reviewed pg_proc;access_rows jsonb;
 owner_id constant oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);
 runtime_id constant oid:=(SELECT oid FROM pg_roles WHERE rolname='app_user');
BEGIN
 FOR item IN SELECT * FROM (VALUES ${checks.map(({reference,name,replacement,app})=>`(${literal(reference)},${literal(name)},${replacement},${app})`).join(',')}) spec(reference,routine,replacement,app) LOOP
  SELECT * INTO STRICT reviewed FROM pg_proc WHERE pronamespace=pg_my_temp_schema() AND proname=item.reference;
  SELECT * INTO actual FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=item.routine AND proargtypes=reviewed.proargtypes;
  IF actual.oid IS NULL OR (to_jsonb(actual)-ARRAY['oid','proname','pronamespace','proacl']) IS DISTINCT FROM
   (to_jsonb(reviewed)-ARRAY['oid','proname','pronamespace','proacl']) THEN
   RAISE EXCEPTION 'conversation_record_helper_source_changed: %',item.routine;
  END IF;
  SELECT jsonb_object_agg(grantee,grantor) INTO access_rows FROM aclexplode(coalesce(actual.proacl,acldefault('f',owner_id)))
   WHERE privilege_type='EXECUTE' AND NOT is_grantable;
  IF actual.proowner<>owner_id OR access_rows IS DISTINCT FROM (jsonb_build_object(owner_id::text,owner_id)||
    CASE WHEN item.app THEN jsonb_build_object(runtime_id::text,owner_id)
         WHEN item.replacement THEN jsonb_build_object('0',owner_id) ELSE '{}'::jsonb END)
   OR (SELECT count(*) FROM aclexplode(coalesce(actual.proacl,acldefault('f',owner_id))))<>
    (CASE WHEN item.app OR item.replacement THEN 2 ELSE 1 END) THEN
   RAISE EXCEPTION 'conversation_record_helper_acl_changed: %',item.routine;
  END IF;
  INSERT INTO a8296_record_reference_oids VALUES(actual.oid);
 END LOOP;
END $record_references$;`,
  cleanup:`DO $record_reference_cleanup$ DECLARE f record;BEGIN
 FOR f IN SELECT p.oid::regprocedure identity FROM pg_proc p WHERE p.pronamespace=pg_my_temp_schema()
 AND p.proname=ANY(ARRAY[${checks.map(({reference})=>literal(reference)).join(',')}])
 LOOP EXECUTE 'DROP FUNCTION '||f.identity;END LOOP;
END $record_reference_cleanup$;`,
 }
}

function recordSchemaReferences(migration){
 const definitions=reviewedSection(migration,'DEFINITIONS')
 const policies=[...definitions.matchAll(/^CREATE POLICY ([a-z_]+) ON public\.(sessions|session_messages)( AS RESTRICTIVE)? FOR SELECT TO app_user\n USING \(([^;]+)\);/gm)]
 const triggers=[...definitions.matchAll(/^CREATE TRIGGER ([a-z_]+) (BEFORE|AFTER) ([A-Z ]+) ON public\.([a-z_]+)\n FOR EACH ROW EXECUTE FUNCTION public\.([a-z_]+)\(\);/gm)]
 const privateTables=[...definitions.matchAll(/^ALTER TABLE public\.([a-z_]+) ENABLE ROW LEVEL SECURITY;/gm)].map(match=>match[1])
 if(policies.length!==4||triggers.length!==7||privateTables.length!==3)throw Error('conversation_record_schema_roster_changed')
 const policyChecks=policies.map(([,name,table,restrictive,expression])=>{
  const peer=table==='sessions'?'a8296_record_policy_sessions':'a8296_record_policy_messages'
  return{table,name,peer,ddl:`CREATE POLICY ${name} ON pg_temp.${peer}${restrictive??''} FOR SELECT TO app_user USING (${expression});`}
 })
 const triggerChecks=triggers.map(([,name,timing,events,table,routine])=>{
  const masks={INSERT:4,UPDATE:16,DELETE:8}
  const mask=events.split(' OR ').reduce((total,event)=>total+masks[event],1+(timing==='BEFORE'?2:0))
  if(!Number.isInteger(mask))throw Error('conversation_record_trigger_event_changed')
  return `(${literal(table)},${literal(name)},${mask},${literal('public.'+routine+'()')})`
 })
 return `CREATE TEMP TABLE a8296_record_policy_sessions(id uuid) ON COMMIT DROP;
CREATE TEMP TABLE a8296_record_policy_messages(session_id uuid,id uuid,sequence_num integer) ON COMMIT DROP;
${policyChecks.map(check=>check.ddl).join('\n')}
DO $record_catalog$ DECLARE item record;actual pg_policy;reviewed pg_policy;relation regclass;
BEGIN
 FOR item IN SELECT * FROM (VALUES ${policyChecks.map(({table,name,peer})=>`(${literal(table)},${literal(name)},${literal(peer)})`).join(',')}) q(relation,policy,peer) LOOP
  relation:=to_regclass('public.'||item.relation);
  SELECT * INTO actual FROM pg_policy WHERE polrelid=relation AND polname=item.policy;
  SELECT * INTO STRICT reviewed FROM pg_policy WHERE polrelid=to_regclass('pg_temp.'||item.peer) AND polname=item.policy;
  IF actual.oid IS NULL OR NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=relation AND relrowsecurity)
   OR ROW(actual.polpermissive,actual.polcmd,actual.polroles,pg_get_expr(actual.polqual,actual.polrelid),pg_get_expr(actual.polwithcheck,actual.polrelid))
   IS DISTINCT FROM ROW(reviewed.polpermissive,reviewed.polcmd,reviewed.polroles,pg_get_expr(reviewed.polqual,reviewed.polrelid),pg_get_expr(reviewed.polwithcheck,reviewed.polrelid)) THEN
   RAISE EXCEPTION 'conversation_record_policy_changed: %.%',item.relation,item.policy;
  END IF;
 END LOOP;
 FOR item IN SELECT * FROM (VALUES ${triggerChecks.join(',')}) q(relation,trigger_name,mask,routine) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.'||item.relation) AND tgname=item.trigger_name
   AND tgfoid=to_regprocedure(item.routine) AND tgtype=item.mask AND tgenabled='O' AND NOT tgisinternal AND tgconstraint=0
   AND tgnargs=0 AND tgattr=''::int2vector AND tgqual IS NULL AND tgoldtable IS NULL AND tgnewtable IS NULL) THEN
   RAISE EXCEPTION 'conversation_record_trigger_changed: %.%',item.relation,item.trigger_name;
  END IF;
 END LOOP;
 FOR relation IN SELECT to_regclass('public.'||name) FROM unnest(ARRAY[${privateTables.map(literal).join(',')}]::text[]) name LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=relation AND c.relkind='r' AND c.relrowsecurity AND NOT c.relforcerowsecurity
    AND c.relowner=(SELECT owner.relowner FROM pg_class owner WHERE owner.oid='public.sessions'::regclass)
    AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
    AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)) THEN
    RAISE EXCEPTION 'conversation_record_private_catalog_changed: %',relation;
   END IF;
 END LOOP;
END $record_catalog$;`
}

/** The predecessor compiler remains unchanged and its final renderer is wrapped once. */
export async function recordInstallationSource(migration,options={}){
 const base=await previousSource(options),references=recordReferences(migration)
 let sql=base.sql
 const declaration=`CREATE FUNCTION pg_temp.${renderer}(routine text,parts jsonb,successor boolean) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $configured_renderer$`
 sql=replaceOnce(sql,declaration,declaration.replace(renderer,previousRenderer))
 sql=replaceOnce(sql,'END $configured_renderer$;',`END $configured_renderer$;\n${recordPublicationRendererSql(renderer,previousRenderer)}`)
 const conversionPair='native_conversation_compiled_frame_pair(uuid,uuid)'
 const conversionSourceRefs=`CREATE TEMP TABLE a8296_record_conversion_predecessor(body text NOT NULL) ON COMMIT DROP;
CREATE FUNCTION pg_temp.a8296_record_plain_body(signature text,template jsonb,successor boolean) RETURNS text LANGUAGE sql AS 'SELECT template->>0';
`
  +recordPublicationRendererSql('a8296_record_direct_source_body','a8296_record_plain_body')
 sql=replaceOnce(sql,'DO $conversion_source_functions$',conversionSourceRefs+'\nDO $conversion_source_functions$')
 const bodyRef="  SELECT * INTO STRICT reference FROM pg_proc WHERE pronamespace=pg_my_temp_schema() AND proname=spec->>'referenceName';"
 const specAt=sql.indexOf('DO $conversion_source_functions$'),specEnd=sql.indexOf('END $conversion_source_functions$;',specAt)
 sql=sql.slice(0,specAt)+replaceOnce(sql.slice(specAt,specEnd),bodyRef,bodyRef+`
  IF spec->>'name'='native_conversation_compiled_frame_pair' THEN
   INSERT INTO pg_temp.a8296_record_conversion_predecessor VALUES(reference.prosrc);END IF;`)+sql.slice(specEnd)
 const sourceCompare=`(to_jsonb(reference)-ARRAY['oid','proname','pronamespace','proacl'])
   OR actual.proowner<>owner_id OR actual.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)]
  THEN RAISE EXCEPTION 'conversion_source_function_mismatch: %'`
 sql=replaceOnce(sql,sourceCompare,`((to_jsonb(reference)-ARRAY['oid','proname','pronamespace','proacl'])||
   CASE WHEN spec->>'name'='native_conversation_compiled_frame_pair' THEN jsonb_build_object('prosrc',
   pg_temp.a8296_record_direct_source_body(${literal(conversionPair)},jsonb_build_array(reference.prosrc),true)) ELSE '{}'::jsonb END)
   OR actual.proowner<>owner_id OR actual.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)]
  THEN RAISE EXCEPTION 'conversion_source_function_mismatch: %'`)
 sql=replaceOnce(sql,'VALUES(routine_signature,jsonb_build_array(actual.prosrc));',`VALUES(routine_signature,jsonb_build_array(
  CASE WHEN routine_signature=${literal(conversionPair)} THEN
   (SELECT p.body FROM pg_temp.a8296_record_conversion_predecessor p) ELSE actual.prosrc END));`)
 const early="'native_turn_helpers_current()','native_turn_publication_contract()','native_session_expired_turn_outcome"
 sql=replaceOnce(sql,`(expected->>'signature') NOT IN(${early}`,`(expected->>'signature') NOT IN(${Object.keys(recordPublicationChanges).map(literal).join(',')},${early}`)
 const receipt='SELECT encode(sha256(convert_to((SELECT jsonb_agg(metadata ORDER BY signature COLLATE "C") FROM pg_temp.a8296_publication_expected_current)::text'
 sql=replaceOnce(sql,receipt,`${references.sql}\n${recordSchemaReferences(migration)}\n${receipt}`)
 const receipts=sql.indexOf(receipt),needle=")::text,'UTF8')),'hex') local_digest,"
 if(receipts<0||!sql.slice(receipts).includes(needle))throw Error('conversation_record_auth_receipt_changed')
 sql=sql.slice(0,receipts)+replaceOnce(sql.slice(receipts),needle,
  `)::text||(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid::regprocedure::text COLLATE "C") FROM pg_proc p JOIN pg_temp.a8296_record_reference_oids r USING(oid))::text,'UTF8')),'hex') local_digest,`)
 sql=replaceOnce(sql,')::int functions,','+'+references.size+')::int functions,')
 sql=sql.replaceAll('a8296_','a8297_');assertAuthenticationReadOnly(sql)
 const cleanup=(base.cleanup+'\n'+references.cleanup+`\nDROP FUNCTION pg_temp.${previousRenderer}(text,jsonb,boolean);
DROP FUNCTION pg_temp.a8296_record_direct_source_body(text,jsonb,boolean);
DROP FUNCTION pg_temp.a8296_record_plain_body(text,jsonb,boolean);`).replaceAll('a8296_','a8297_')
 return{...base,sql,cleanup,sourceDigest:sha(migration),migrationSha:sha(migration),functions:previousCount+references.size}
}

export async function currentInstallationAuthenticationSource({sourceRoot=fileURLToPath(new URL('../../',import.meta.url))}={}){
 const migration=await readFile(sourceRoot.replace(/\/$/,'')+'/migrations/'+migrationName,'utf8')
 if(sha(migration)!==currentMigrationSha)throw Error('installation_source_migration_changed')
 return recordInstallationSource(migration,{sourceRoot})
}

export async function authenticateConversationInstallation(ownerClient,options){
 if(ownerClient?.getTransactionStatus?.()!=='I')throw Error('installation_authentication_requires_idle_owner')
 const source=await currentInstallationAuthenticationSource(options);await ownerClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
 try{
  const result=await ownerClient.query(source.sql),row=(Array.isArray(result)?result.at(-1):result)?.rows?.[0]
  if(!row||row.functions!==source.functions||!/^[a-f0-9]{64}$/.test(row.local_digest)||typeof row.witness_current!=='boolean')
   throw Error('installation_authentication_receipt_malformed')
  await ownerClient.query(source.cleanup);await ownerClient.query('COMMIT')
  return Object.freeze({format:1,sourceDefinitionDigest:source.sourceDigest,functions:row.functions,
   localContractDigest:row.local_digest,witnessCurrent:row.witness_current})
 }catch(error){await ownerClient.query('ROLLBACK').catch(()=>{});throw error}
}
