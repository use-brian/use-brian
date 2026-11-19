// [COMP:api/migration-owner-role] Closed setting retirement for the current executable definitions.
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {executableProjection} from './executable-record.mjs'

const q=value=>"'"+value.replaceAll("'","''")+"'"
const sha=value=>createHash('sha256').update(value).digest('hex')
const marker='app.system_bypass'
const replaceOnce=(source,part,next='')=>{
 if(source.split(part).length!==2)throw Error('legacy_bypass_source_shape_changed: '+part)
 return source.replace(part,()=>next)
}

export const legacyBypassContextFunctions=Object.freeze([
 ['capture_native_session_projection_batch(uuid,uuid,integer,text)',6],
 ['capture_native_session_query_stage(uuid,uuid,integer,text,jsonb,jsonb)',1],
 ['fused_f_capture(uuid,jsonb,jsonb,jsonb,text)',2],
 ['native_turn_context()',1],
 ['native_worklist_context(uuid,jsonb)',1],
])
export const fusedCaptureSignature='fused_f_capture(uuid,jsonb,jsonb,jsonb,text)'

/** The frozen fused compiler has a separate checked reference and roster. */
export function bypassFusedCaptureSql(prefix){
 return `DO $legacy_bypass_fused_capture$
 DECLARE routine_signature constant text:=${q(fusedCaptureSignature)};
  retired constant text:=${q("'"+marker+"',")};
  actual pg_proc; checked_body text; next_body text; definition text; installed pg_proc;
 BEGIN
  SELECT * INTO STRICT actual FROM pg_proc WHERE oid=to_regprocedure('public.'||routine_signature);
  SELECT prosrc INTO STRICT checked_body FROM pg_proc WHERE oid=to_regprocedure('pg_temp.${prefix}f_r_'||routine_signature);
  IF actual.prosrc IS DISTINCT FROM checked_body
   OR (length(checked_body)-length(replace(checked_body,retired,'')))/length(retired)<>2
   OR NOT EXISTS(SELECT 1 FROM public.native_turn_contract_helpers h
      WHERE h.signature=routine_signature AND h.contract IS NOT DISTINCT FROM ${executableProjection('actual')})
  THEN RAISE EXCEPTION 'legacy_bypass_fused_predecessor_changed';END IF;
  IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid<>actual.oid AND p.pronamespace<>pg_my_temp_schema()
   AND (strpos(p.prosrc,encode(sha256(convert_to(checked_body,'UTF8')),'hex'))>0
    OR strpos(p.prosrc,md5(checked_body))>0
    OR strpos(p.prosrc,encode(sha256(convert_to(to_jsonb(actual)::text,'UTF8')),'hex'))>0
    OR strpos(p.prosrc,encode(sha256(convert_to(${executableProjection('actual')}::text,'UTF8')),'hex'))>0))
   OR EXISTS(SELECT 1 FROM public.native_retained_contract_helpers h WHERE h.signature=routine_signature)
  THEN RAISE EXCEPTION 'legacy_bypass_unreviewed_fused_pin';END IF;
  next_body:=replace(checked_body,retired,'');
  definition:=pg_get_functiondef(actual.oid);
  IF (length(definition)-length(replace(definition,checked_body,'')))/length(checked_body)<>1 THEN
   RAISE EXCEPTION 'legacy_bypass_fused_declaration_changed';
  END IF;
  EXECUTE replace(definition,checked_body,next_body);
  SELECT * INTO STRICT installed FROM pg_proc WHERE oid=actual.oid;
  IF to_jsonb(installed) IS DISTINCT FROM jsonb_set(to_jsonb(actual),'{prosrc}',to_jsonb(next_body)) THEN
   RAISE EXCEPTION 'legacy_bypass_fused_successor_changed';
  END IF;
  UPDATE public.native_turn_contract_helpers h SET contract=${executableProjection('installed')} WHERE h.signature=routine_signature;
 END $legacy_bypass_fused_capture$;`
}

export function bypassContextRendererSql(name,predecessor){
 return `CREATE FUNCTION pg_temp.${name}(routine text,parts jsonb,successor boolean) RETURNS text
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $legacy_bypass_renderer$
 DECLARE body text;declared_count integer;retired constant text:=${q("'"+marker+"',")};
 BEGIN
  body:=pg_temp.${predecessor}(routine,parts,successor);
  SELECT reads INTO declared_count FROM (VALUES ${legacyBypassContextFunctions.filter(([name])=>name!==fusedCaptureSignature).map(([routine,reads])=>`(${q(routine)},${reads})`).join(',')}) decl(signature,reads)
   WHERE signature=routine;
  IF declared_count IS NULL THEN RETURN body; END IF;
  IF (length(body)-length(replace(body,retired,'')))/length(retired) IS DISTINCT FROM declared_count THEN
   RAISE EXCEPTION 'legacy_bypass_context_source_changed: %',routine;
  END IF;
  RETURN replace(body,retired,'');
 END $legacy_bypass_renderer$;`
}

// Signed historical declarations for the eight ordinary routines, plus the
// owner/app/default ACL from their original installations. Query/capture pin
// consumers are compiled separately through the closed native renderer.
const predecessors=[
 ['admit_knowledge_repo_write(jsonb,jsonb,jsonb,uuid,text)','8081_knowledge_repo_publication.sql','8b002e06ebe6a11cbe5cc40a7cf9dc887f3a71b323bb9b7a70b30745cec08d78','b4855c0f70a23ecc416ff39f3b6710c70962a2b74648851339e0b4d3d1698913','app'],
 ['application_native_task_review_current(uuid,uuid)','8123_native_task_review_classification.sql','dd3b8fd8c813f42d037295a8bef7e8c09b683654643e7dfd9e92bf3b9375a18c','df575f7a46b8a7d7fc6ddeb9ba376762a3ee0e71c3f41dcefc9be31e4381ce33','owner'],
 ['apply_knowledge_source_refresh(jsonb,jsonb)','8081_knowledge_repo_publication.sql','8b002e06ebe6a11cbe5cc40a7cf9dc887f3a71b323bb9b7a70b30745cec08d78','e7da994df3db0909fbfd5729391915166a1957a5c5c8316d30c7b2b947f2e2af','app'],
 ['can_view_department_directory(uuid,uuid)','566_department_read_requests.sql','41880ee8bb25b970a6ed3cbc05bfb3fbc6694e5b248f272239db13837f33c2f1','f13a473eef84cdcfb7cc4146e1a72c2f00b51eb39fe38dff38fb2555987cbfdc','public'],
 ['crm_activity_scope_allows(crm_activities,boolean)','677_crm_activity_department_floor.sql','fe5695bb71b13c9eec18dfe07e0a2a45074a45f417ee1d8ac3d7c086aec56343','99bd384c272a2da1799eb7c90e78e17892faa25d2568376df777cd4cf7ce53e5','public'],
 ['native_knowledge_creation_fields_allowed(uuid,text[],uuid,text)','8078_native_knowledge_creation_field_intent.sql','1268247e3e9d660067ae393f30a5e5513836f8aa527e34afc523ed86dc2ddadb','fe0d7345e98b601ae1a0dbc30015463ebfdcacad931f61867c4036a1e3f2b482','app'],
 ['record_admitted_knowledge_entry_derivation(uuid,uuid,text,text,jsonb)','8077_native_knowledge_entry_lineage.sql','23a6870e4ab788533973ca6f28d5a28863cdcd654b3d382e818bcc8fe34982f6','d3a9f9ce6e8ba66e32dd70054e72eda74ab1c08ca765b5e01dbe5cf3edc7a81e','app'],
 ['update_admitted_knowledge_entry_body(uuid,uuid,text,text,text,jsonb,text[],uuid[])','8079_native_knowledge_body_update.sql','ca70c2eae4f607aa03188a1aa3a2eda9261183f9bfdbf8db70026663985e7b81','1c98257346b82f551627d48639f4dee1ce41ce143c88347ee87d33dfbbcf2e2e','app'],
]
const legacyGrant="current_setting('app.system_bypass',true)='true'"

function successorBody(name,body){
 switch(name){
  case 'application_native_task_review_current':return replaceOnce(body,"'"+marker+"',")
  case 'apply_knowledge_source_refresh':return replaceOnce(body,'  OR '+legacyGrant+'\n')
  case 'can_view_department_directory':return replaceOnce(body,'  IF '+legacyGrant+' THEN RETURN true; END IF;\n')
  case 'crm_activity_scope_allows':return replaceOnce(replaceOnce(body,'CASE WHEN '+legacyGrant+' THEN true ELSE '),'\n    ) END\n','\n    )\n')
  default:return replaceOnce(body,' OR '+legacyGrant)
 }
}

export function bypassOrdinaryFunctionsSql(sourceRoot){
 const routines=predecessors.map(([signature,file,digest,bodyDigest,acl])=>{
  const source=readFileSync(sourceRoot+'/migrations/'+file,'utf8')
  if(sha(source)!==digest)throw Error('legacy_bypass_predecessor_file_changed: '+file)
  const [name]=signature.split('(')
  const declaration=source.match(new RegExp('^CREATE (?:OR REPLACE )?FUNCTION '+name+'\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;', 'm'))
  if(!declaration||sha(declaration[1])!==bodyDigest)throw Error('legacy_bypass_predecessor_body_changed: '+signature)
  const body=declaration[1], next=successorBody(name,body)
  if(next.includes(marker))throw Error('legacy_bypass_source_body_still_reads_setting: '+signature)
  const head=declaration[0].slice(declaration[0].indexOf(name+'('))
  return {signature,acl,name,args:signature.slice(name.length),body,head,next,bodyDigest}
 })
 const authenticate=(retired)=>routines.map((routine,index)=>{
  const {head,name,body,bodyDigest,next,signature,args,acl}=routine
  const ref=(retired?'legacy_bypass_successor_':'legacy_bypass_predecessor_')+index
  const declaration=retired?head.replace(body,()=>next):head
  const ownerAcl="makeaclitem(owner_role,owner_role,'EXECUTE',false)"
  const appAcl="makeaclitem('app_user'::regrole,owner_role,'EXECUTE',false)"
  const want=acl==='public'?'NULL':acl==='app'?`ARRAY[${ownerAcl},${appAcl}]`:`ARRAY[${ownerAcl}]`
  return `CREATE FUNCTION pg_temp.${ref}${declaration.slice(name.length)}
 DO $legacy_bypass_predecessor$
 DECLARE actual pg_proc;reference pg_proc;owner_role oid:=(SELECT relowner FROM pg_class WHERE oid='public.workspaces'::regclass);
 BEGIN
  SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure(${q('public.'+signature)});
  SELECT * INTO STRICT reference FROM pg_proc WHERE oid=to_regprocedure(${q('pg_temp.'+ref+args)});
  IF actual.oid IS NULL OR actual.pronamespace<>'public'::regnamespace OR actual.proowner<>owner_role OR actual.proacl IS DISTINCT FROM ${want}
   OR (to_jsonb(actual)-ARRAY['oid','proname','pronamespace','proowner','proacl']) IS DISTINCT FROM
      (to_jsonb(reference)-ARRAY['oid','proname','pronamespace','proowner','proacl'])
  THEN RAISE EXCEPTION 'legacy_bypass_function_predecessor_changed: %',${q(signature)};END IF;
  ${retired?'':`IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid<>actual.oid AND p.pronamespace<>pg_my_temp_schema()
   AND (strpos(p.prosrc,${q(bodyDigest)})>0 OR strpos(p.prosrc,md5(actual.prosrc))>0
    OR strpos(p.prosrc,encode(sha256(convert_to(to_jsonb(actual)::text,'UTF8')),'hex'))>0
    OR strpos(p.prosrc,encode(sha256(convert_to(${executableProjection('actual')}::text,'UTF8')),'hex'))>0))
   OR EXISTS(SELECT 1 FROM public.native_turn_contract_helpers WHERE signature=${q(signature)})
   OR EXISTS(SELECT 1 FROM public.native_retained_contract_helpers WHERE signature=${q(signature)})
  THEN RAISE EXCEPTION 'legacy_bypass_unreviewed_function_pin: %',${q(signature)};END IF;`}
 END $legacy_bypass_predecessor$;
 DROP FUNCTION pg_temp.${ref}${args};`
 }).join('\n')
 const install=routines.map(({head,body,next})=>'CREATE OR REPLACE FUNCTION public.'+head.replace(body,()=>next)).join('\n')
 const all=[...routines.map(r=>r.signature),...legacyBypassContextFunctions.map(([name])=>name)]
 const inventory=`DO $legacy_bypass_function_inventory$ DECLARE actual text[];
 BEGIN
  SELECT array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text COLLATE "C") INTO actual
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname!~'^pg_' AND strpos(p.prosrc,${q(marker)})>0;
  IF actual IS DISTINCT FROM ARRAY[${all.sort().map(q).join(',')}]::text[] THEN
   RAISE EXCEPTION 'legacy_bypass_function_inventory_changed: %',actual;
  END IF;
 END $legacy_bypass_function_inventory$;`
 return {auth:authenticate(false),successorAuth:authenticate(true),ordinarySignatures:routines.map(r=>r.signature),install,inventory}
}

export const assertLegacyBypassRetiredSql=`DO $legacy_bypass_postconditions$ DECLARE remaining text;
 BEGIN
  SELECT p.oid::regprocedure::text INTO remaining FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname!~'^pg_' AND strpos(p.prosrc,${q(marker)})>0 LIMIT 1;
  IF remaining IS NOT NULL THEN RAISE EXCEPTION 'legacy_bypass_function_reader_remains: %',remaining;END IF;
  SELECT p.polrelid::regclass::text||'.'||p.polname INTO remaining FROM pg_policy p
   WHERE p.polrelid<>coalesce(to_regclass('public.pending_classifications')::oid,0::oid)
     AND strpos(concat(pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)),${q(marker)})>0 LIMIT 1;
  IF remaining IS NOT NULL THEN RAISE EXCEPTION 'legacy_bypass_policy_reader_remains: %',remaining;END IF;
 END $legacy_bypass_postconditions$;`
