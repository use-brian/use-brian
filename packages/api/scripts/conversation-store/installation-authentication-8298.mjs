// [COMP:api/migration-owner-role] Read-only source profile for the retired setting.
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {currentInstallationAuthenticationSource as predecessorSource,assertAuthenticationReadOnly as predecessorReadOnly} from './installation-authentication-8297.mjs'
import {assertLegacyBypassRetiredSql,bypassContextRendererSql,bypassOrdinaryFunctionsSql,fusedCaptureSignature,legacyBypassContextFunctions} from './legacy-bypass-functions.mjs'

const sha=value=>createHash('sha256').update(value).digest('hex')
const q=value=>"'"+value.replaceAll("'","''")+"'"
const once=(source,before,after)=>{
 if(source.split(before).length!==2)throw Error('legacy_bypass_auth_source_changed: '+before.slice(0,90))
 return source.replace(before,()=>after)
}
const migrationName='8298_legacy_bypass_retirement.sql'
const currentMigrationSha='e0dba38f73b1ebdefaeab8d9bf53b77f5a041451365faef872646444b909fefd'
const prefix='a8297_',renderer=prefix+'conversion_source_body',previousRenderer=prefix+'bypass_pred_source_body'
const admissionSignature='read_workspace_admission_policy(uuid)'
const reviewedContexts=legacyBypassContextFunctions.filter(([signature])=>signature!==fusedCaptureSignature).map(([signature])=>signature)
const read=name=>readFile(new URL(name,import.meta.url),'utf8')

export function assertAuthenticationReadOnly(sql){return predecessorReadOnly(sql.replaceAll('a8298_','a8297_'))}

function authenticateAdmission(declaration){
 const end=declaration.indexOf('REVOKE ALL ON FUNCTION')
 if(end<0)throw Error('legacy_bypass_admission_declaration_changed')
 const name=prefix+'admission_policy_ref'
 const reference=once(declaration.slice(0,end),'CREATE FUNCTION public.read_workspace_admission_policy(',`CREATE FUNCTION pg_temp.${name}(`)
 return `${reference}
DO $bypass_admission_reference$
DECLARE actual pg_proc;reference pg_proc;owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.workspaces'::regclass);
BEGIN
 SELECT * INTO STRICT actual FROM pg_proc WHERE oid='public.${admissionSignature}'::regprocedure;
 SELECT * INTO STRICT reference FROM pg_proc WHERE oid='pg_temp.${name}(uuid)'::regprocedure;
 IF actual.proowner<>owner_id OR (to_jsonb(actual)-ARRAY['oid','proname','pronamespace','proacl'])
  IS DISTINCT FROM (to_jsonb(reference)-ARRAY['oid','proname','pronamespace','proacl'])
  OR (SELECT count(*) FROM aclexplode(actual.proacl))<>2
  OR EXISTS(SELECT 1 FROM aclexplode(actual.proacl) a WHERE a.grantor<>owner_id
      OR a.grantee NOT IN(owner_id,'app_user'::regrole) OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
 THEN RAISE EXCEPTION 'legacy_bypass_admission_member_changed';END IF;
END $bypass_admission_reference$;
DROP FUNCTION pg_temp.${name}(uuid);`
}

async function authenticatePolicies(){
 const [policy,setup]=await Promise.all([read('legacy-bypass-policies.sql'),read('../../migrations/622_connector_pending_setups.sql')])
 const marker='DO $legacy_policy_inventory$'
 if(policy.split(marker).length!==2||sha(setup)!=='faa907ee38ce1dc30e00b90f80bfcb36367da9808f6c0571702ea8b1990387aa')
  throw Error('legacy_bypass_policy_sources_changed')
 const lists=policy.split(marker)[0]
 const setupRead=setup.match(/^CREATE POLICY connector_setup_owner_read[\s\S]+?;$/m)?.[0]
 const review=policy.match(/approval_successor constant text:=\$expr\$([\s\S]+?)\$expr\$;/)?.[1]
 if(!setupRead||!review)throw Error('legacy_bypass_policy_author_sources_changed')
 return `${lists}
CREATE TEMP TABLE a8297_bypass_setup_ref(actor_user_id uuid,workspace_id uuid) ON COMMIT DROP;
${setupRead.replaceAll('public.connector_pending_setups','pg_temp.a8297_bypass_setup_ref').replaceAll('connector_pending_setups.workspace_id','a8297_bypass_setup_ref.workspace_id')}
CREATE TEMP TABLE a8297_bypass_approval_ref(kind text,approval_payload jsonb) ON COMMIT DROP;
CREATE POLICY department_approval_privacy ON pg_temp.a8297_bypass_approval_ref AS RESTRICTIVE FOR SELECT USING (${review});
DO $bypass_policy_successor$
DECLARE t record;rel pg_class;p pg_policy;r pg_policy;
 owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.workspaces'::regclass);
BEGIN
 IF pg_has_role('app_user',owner_id,'MEMBER') THEN RAISE EXCEPTION 'legacy_bypass_connector_owner_unsafe';END IF;
 FOR t IN SELECT * FROM pg_temp.legacy_bypass_policies LOOP
  SELECT * INTO STRICT rel FROM pg_class WHERE oid=to_regclass(format('public.%I',t.relation));
  SELECT * INTO p FROM pg_policy WHERE polrelid=rel.oid AND polname=t.policy;
  IF NOT rel.relrowsecurity OR rel.relforcerowsecurity IS DISTINCT FROM t.forced
    OR (NOT t.forced AND p.oid IS NOT NULL)
    OR (t.forced AND (rel.relowner<>owner_id OR p.oid IS NULL OR p.polcmd<>'*' OR NOT p.polpermissive
      OR p.polroles<>ARRAY[owner_id] OR pg_get_expr(p.polqual,rel.oid) IS DISTINCT FROM 'true'
      OR pg_get_expr(p.polwithcheck,rel.oid) IS DISTINCT FROM 'true'
      OR (SELECT count(*) FROM pg_policy WHERE polrelid=rel.oid)<>CASE WHEN t.relation='connector_pending_setups' THEN 2 ELSE 1 END))
  THEN RAISE EXCEPTION 'legacy_bypass_policy_successor_changed: %.%',t.relation,t.policy;END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_temp.legacy_bypass_inert_policies inert JOIN pg_class c ON c.relname=inert.relation
    JOIN pg_policy pol ON pol.polrelid=c.oid AND pol.polname=inert.policy WHERE c.relnamespace='public'::regnamespace)
 THEN RAISE EXCEPTION 'legacy_bypass_inert_successor_changed';END IF;
 FOR t IN SELECT * FROM (VALUES ('connector_pending_setups','a8297_bypass_setup_ref','connector_setup_owner_read'),
   ('pending_approvals','a8297_bypass_approval_ref','department_approval_privacy')) policy(relation,reference,policy) LOOP
  SELECT * INTO STRICT p FROM pg_policy WHERE polrelid=to_regclass('public.'||t.relation) AND polname=t.policy;
  SELECT * INTO STRICT r FROM pg_policy WHERE polrelid=to_regclass('pg_temp.'||t.reference) AND polname=t.policy;
  IF (p.polcmd,p.polpermissive,p.polroles,pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid))
    IS DISTINCT FROM (r.polcmd,r.polpermissive,r.polroles,
      replace(pg_get_expr(r.polqual,r.polrelid),t.reference||'.',t.relation||'.'),pg_get_expr(r.polwithcheck,r.polrelid))
  THEN RAISE EXCEPTION 'legacy_bypass_policy_floor_changed: %',t.policy;END IF;
 END LOOP;
END $bypass_policy_successor$;
DROP TABLE pg_temp.a8297_bypass_setup_ref,pg_temp.a8297_bypass_approval_ref,
 pg_temp.legacy_bypass_policies,pg_temp.legacy_bypass_inert_policies;
${assertLegacyBypassRetiredSql}`
}

export async function currentInstallationAuthenticationSource({sourceRoot=fileURLToPath(new URL('../../',import.meta.url))}={}){
 const root=sourceRoot.replace(/\/$/,''),migration=await readFile(root+'/migrations/'+migrationName,'utf8')
 if(sha(migration)!==currentMigrationSha)throw Error('installation_source_migration_changed')
 const source=await predecessorSource({sourceRoot}),ordinary=bypassOrdinaryFunctionsSql(root)
 const [admission,policies]=await Promise.all([read('legacy-bypass-admission-policy.sql'),authenticatePolicies()])
 let sql=source.sql
 const declaration=`CREATE FUNCTION pg_temp.${renderer}(signature text,template jsonb,successor boolean)`
 const rendererStart=sql.indexOf(declaration),marker='END $record_publication_renderer$;'
 const rendererEnd=sql.indexOf(marker,rendererStart)+marker.length
 if(rendererStart<0||rendererEnd<=rendererStart)throw Error('legacy_bypass_auth_renderer_changed')
 sql=sql.slice(0,rendererEnd)+'\n'+bypassContextRendererSql(renderer,previousRenderer)+sql.slice(rendererEnd)
 sql=once(sql,declaration,declaration.replace(renderer,previousRenderer))
 sql=once(sql,"(expected->>'signature') NOT IN(",`(expected->>'signature') NOT IN(${reviewedContexts.map(q).join(',')},`)

 // The fused emitter has an independent temp compiler and an exact paired
 // check. Compile its reviewed two-removal successor in that same reference.
 const begin=` EXECUTE format('CREATE FUNCTION pg_temp.${prefix}f_r_fused_f_capture(`
 const start=sql.indexOf(begin),end=sql.indexOf(" EXECUTE format('CREATE FUNCTION pg_temp.",start+begin.length)
 if(start<0||end<0||sql.split(begin).length!==2)throw Error('legacy_bypass_fused_reference_changed')
 const retired="''app.system_bypass'',",fused=sql.slice(start,end)
 if(fused.split(retired).length!==3)throw Error('legacy_bypass_fused_reference_changed')
 sql=sql.slice(0,start)+fused.replaceAll(retired,'')+sql.slice(end)

 // The separate fused cohort checks a normalized digest of the earlier
 // canonical turn context. Authenticate that digest from the exact reviewed
 // template. The renderer independently verifies the current successor body.
 const gate='WHERE p.oid IS NULL OR encode(sha256(convert_to(regexp_replace(regexp_replace(p.prosrc,'
 sql=once(sql,gate,gate.replace('p.prosrc,',`CASE WHEN x.signature='native_turn_context()' THEN
  pg_temp.${previousRenderer}(x.signature,(SELECT parts FROM pg_temp.${prefix}publication_successor_templates WHERE signature=x.signature),true)
  ELSE p.prosrc END,`))

 const receipt=`SELECT encode(sha256(convert_to((SELECT jsonb_agg(metadata ORDER BY signature COLLATE "C") FROM pg_temp.${prefix}publication_expected_current)::text`
 sql=once(sql,receipt,`${ordinary.successorAuth}\n${authenticateAdmission(admission)}\n${policies}\n${receipt}`)
 const signers=[...ordinary.ordinarySignatures,admissionSignature], startReceipt=sql.indexOf(receipt), separator=")::text,'UTF8')),'hex') local_digest,"
 sql=sql.slice(0,startReceipt)+once(sql.slice(startReceipt),separator,`)::text||(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid::regprocedure::text COLLATE "C")
  FROM pg_proc p WHERE p.oid=ANY(ARRAY[${signers.map(signature=>q('public.'+signature)+'::regprocedure').join(',')}]::oid[]))::text,'UTF8')),'hex') local_digest,`)
 sql=once(sql,')::int functions,',`+${signers.length})::int functions,`)
 sql=sql.replaceAll(prefix,'a8298_')
 assertAuthenticationReadOnly(sql)
 const cleanup=(source.cleanup+`\nDROP FUNCTION pg_temp.${previousRenderer}(text,jsonb,boolean);`).replaceAll(prefix,'a8298_')
 return {...source,sql,cleanup,sourceDigest:currentMigrationSha,migrationSha:currentMigrationSha,functions:source.functions+signers.length}
}

export async function authenticateConversationInstallation(ownerClient,options){
 if(ownerClient?.getTransactionStatus?.()!=='I')throw Error('installation_authentication_requires_idle_owner')
 const source=await currentInstallationAuthenticationSource(options)
 await ownerClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
 try{
  const result=await ownerClient.query(source.sql),row=(Array.isArray(result)?result.at(-1):result)?.rows?.[0]
  if(!row||row.functions!==source.functions||!/^[a-f0-9]{64}$/.test(row.local_digest)||typeof row.witness_current!=='boolean')
   throw Error('installation_authentication_receipt_malformed')
  await ownerClient.query(source.cleanup)
  await ownerClient.query('COMMIT')
  return Object.freeze({format:1,sourceDefinitionDigest:source.sourceDigest,functions:row.functions,
   localContractDigest:row.local_digest,witnessCurrent:row.witness_current})
 }catch(error){await ownerClient.query('ROLLBACK').catch(()=>{});throw error}
}
