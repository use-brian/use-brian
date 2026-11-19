// [COMP:api/configured-capture-authority] Source-known 8296 helpers and closed renderer.
// Read-only source compilation; never learn a new authority from a target catalog.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { executableProjection } from './executable-record.mjs'
const here=fileURLToPath(new URL('./',import.meta.url)),q=value=>"'"+value.replaceAll("'","''")+"'"
const sha=value=>createHash('sha256').update(value).digest('hex')
const once=(source,needle,value)=>{if(source.split(needle).length!==2)throw Error('configured_task_source_shape_changed: '+needle.slice(0,60));return source.replace(needle,()=>value)}
export const configuredSignatures=Object.freeze(['protect_configured_task_receipt()','seal_configured_task_candidate()',
 'assert_programmatic_publication_current(uuid,uuid)','configured_task_source_commit_allowed(uuid,uuid,text,jsonb)'])
const source=readFileSync(here+'configured-task-publication.sql','utf8')
export const configuredSourceSha=sha(source)
export const configuredSourceSql=source
const definitions=new Map([...source.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.([a-z_]+)\(([\s\S]*?)\) RETURNS[\s\S]*?AS \$\$([\s\S]*?)\$\$;/g)]
 .map(match=>[match[1],{declaration:match[0].replace('CREATE OR REPLACE FUNCTION','CREATE FUNCTION'),body:match[3]}]))
const previous=[
 {signature:'application_recheck_native_task_sources()',file:'8051_application_native_operation_completion.sql',
  fileSha:'d22c5a2c4752198f454073ea00a80bcbfc345a35b556ec8add5675122a934384',bodySha:'523bf32eecbcd2465116422de7a963c5ca8cf949acca0b59e797cda80db73be5',private:true},
 {signature:'check_programmatic_publication_commit()',file:'770_engineering_pending_archive_erasure.sql',
  fileSha:'bf566910b58bf7fd62aa01d298e721d498296dc9f0d16fd1f887062fa2ab950c',bodySha:'6de33a0b77f7daddd0d7aaf5ba3527987308c6ea35e06b9934cea588606c7b14',private:false},
].map(item=>{
 const text=readFileSync(here+'../../migrations/'+item.file,'utf8');if(sha(text)!==item.fileSha)throw Error('configured_task_predecessor_file_changed')
 const name=item.signature.split('(')[0],replacement='CREATE OR REPLACE FUNCTION '+name+'('
 const at=Math.max(text.indexOf('CREATE FUNCTION '+name+'('),text.indexOf(replacement)),open=text.indexOf('AS $$',at),close=text.indexOf('$$;',open+5)
 if(at<0||open<0||close<0)throw Error('configured_task_predecessor_declaration_missing')
 const declaration=text.slice(at,close+3).replace('CREATE OR REPLACE FUNCTION','CREATE FUNCTION'),body=text.slice(open+5,close)
 if(sha(body)!==item.bodySha)throw Error('configured_task_predecessor_body_changed')
 return Object.freeze({...item,name,declaration,body})
})
export const configuredOrdinaryPredecessors=Object.freeze(previous)
const task=previous[0],taskBranch="IF application_canonical_ancestry_allowed(NEW.workspace_id,'task',physical,version,true) IS NOT TRUE THEN"
const taskBody=once(task.body,taskBranch,'IF public.configured_task_source_commit_allowed(NEW.workspace_id,physical,version,to_jsonb(NEW)) THEN RETURN NULL;END IF; '+taskBranch)
const taskDeclaration=task.declaration.replace('CREATE FUNCTION '+task.name+'(','CREATE FUNCTION public.'+task.name+'(').replace(task.body,()=>taskBody)
definitions.set(task.name,{declaration:taskDeclaration,body:taskBody})
export const configuredDeclarations=Object.freeze([...configuredSignatures,'check_programmatic_publication_commit()',task.signature].map(signature=>{
 const name=signature.split('(')[0],definition=definitions.get(name);if(!definition)throw Error('configured_task_definition_missing: '+name)
 return Object.freeze({signature,name,...definition})
}))
export function configuredRendererSql(name,predecessor){
 return `CREATE FUNCTION pg_temp.${name}(routine text,parts jsonb,successor boolean) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $configured_renderer$
DECLARE body text;anchor constant text:='array_agg(h.signature ORDER BY h.signature)=';start_at integer;end_at integer;old_array text;names text[];rendered text;
BEGIN
 body:=pg_temp.${predecessor}(routine,parts,successor);
 IF routine='native_turn_helpers_current()' THEN
  IF (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'configured_task_root_source_changed';END IF;
  start_at:=strpos(body,anchor)+length(anchor);end_at:=strpos(substring(body FROM start_at),'::text[]')+start_at-1;
  old_array:=substring(body FROM start_at FOR end_at-start_at);
  SELECT array_agg(replace(m[1],'''''','''') ORDER BY o) INTO names FROM regexp_matches(old_array,'''((?:[^'']|'''')*)''','g') WITH ORDINALITY x(m,o);
  IF old_array IS DISTINCT FROM (SELECT 'ARRAY['||string_agg(quote_literal(s),',' ORDER BY s)||']' FROM unnest(names) s)
   OR names&&ARRAY[${configuredSignatures.map(q).join(',')}]::text[] THEN RAISE EXCEPTION 'configured_task_root_roster_changed';END IF;
  SELECT 'ARRAY['||string_agg(quote_literal(s),',' ORDER BY s)||']' INTO rendered FROM unnest(names||ARRAY[${configuredSignatures.map(q).join(',')}]::text[]) s;
  body:=substring(body FROM 1 FOR start_at-1)||rendered||substring(body FROM end_at);
 END IF;
 RETURN body;
END $configured_renderer$;`
}

/** References are compiled from declared source, with source-defined private ACL. */
export function configuredAuthenticationSql(prefix,{predecessor=false,registry=true}={}){
 const members=predecessor?previous:configuredDeclarations
 return members.map((member,index)=>{
  const ref=prefix+'reference_'+index,signature=member.signature,reference=member.declaration.replace(new RegExp('CREATE FUNCTION (?:public\\.)?'+member.name+'\\('),'CREATE FUNCTION pg_temp.'+ref+'(')
  if(reference===member.declaration)throw Error('configured_task_reference_shape_changed')
  const privateAcl=!predecessor||member.private
  return `DO $${prefix}compile_${index}$ BEGIN EXECUTE ${q(reference)};END $${prefix}compile_${index}$;
${privateAcl?`REVOKE ALL ON FUNCTION pg_temp.${ref}${signature.slice(signature.indexOf('('))} FROM PUBLIC,app_user;`:''}
DO $${prefix}member_${index}$ DECLARE actual pg_proc;reference pg_proc;owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.workspaces'::regclass);BEGIN
 SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure(${q('public.'+signature)});
 SELECT * INTO STRICT reference FROM pg_proc WHERE oid=to_regprocedure(${q('pg_temp.'+ref+signature.slice(signature.indexOf('(')))});
 IF actual.oid IS NULL OR actual.pronamespace<>'public'::regnamespace OR actual.proowner<>owner_id
  OR (to_jsonb(actual)-ARRAY['oid','proname','pronamespace','proowner','proacl']) IS DISTINCT FROM (to_jsonb(reference)-ARRAY['oid','proname','pronamespace','proowner','proacl'])
  OR actual.proacl IS DISTINCT FROM ${privateAcl?"ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)]":'NULL'}
  ${!predecessor&&registry&&configuredSignatures.includes(signature)?`OR NOT EXISTS(SELECT 1 FROM public.native_turn_contract_helpers h WHERE h.signature=${q(signature)} AND h.contract IS NOT DISTINCT FROM ${executableProjection('actual')})`:''}
 THEN RAISE EXCEPTION 'configured_task_source_member_changed: %',${q(signature)};END IF;
 ${predecessor?`IF EXISTS(SELECT 1 FROM public.native_turn_contract_helpers h WHERE h.signature=${q(signature)})
  OR EXISTS(SELECT 1 FROM pg_proc consumer WHERE consumer.oid<>actual.oid
   AND (strpos(consumer.prosrc,encode(sha256(convert_to(to_jsonb(actual)::text,'UTF8')),'hex'))>0
    OR strpos(consumer.prosrc,encode(sha256(convert_to(${executableProjection('actual')}::text,'UTF8')),'hex'))>0
    OR strpos(consumer.prosrc,${q(member.bodySha)})>0
    OR strpos(consumer.prosrc,md5(actual.prosrc))>0))
 THEN RAISE EXCEPTION 'configured_task_ordinary_pin_consumer: %',${q(signature)};END IF;`:''}
END $${prefix}member_${index}$;`
 }).join('\n')
}
export function configuredReferenceCleanup(prefix,{predecessor=false}={}){
 return (predecessor?previous:configuredDeclarations).map((member,index)=>`DROP FUNCTION pg_temp.${prefix}reference_${index}${member.signature.slice(member.signature.indexOf('('))};`).join('\n')
}

/** New catalog structure is declared here, not copied from the installation. */
export function configuredSchemaAuthenticationSql(prefix){
 return `CREATE TEMP TABLE pg_temp.${prefix}item_reference(target_record_id text,configured_txid xid8,configured_backend_pid integer,configured_source jsonb,configured_task jsonb,
 CONSTRAINT configured_task_receipt_complete CHECK(num_nonnulls(configured_txid,configured_backend_pid,configured_source,configured_task) IN(0,4)));
CREATE UNIQUE INDEX ${prefix}target_reference ON pg_temp.${prefix}item_reference(target_record_id) WHERE configured_txid IS NOT NULL;
CREATE TRIGGER configured_task_receipt_guard BEFORE INSERT OR UPDATE ON pg_temp.${prefix}item_reference FOR EACH ROW EXECUTE FUNCTION public.protect_configured_task_receipt();
CREATE TRIGGER configured_task_candidate_seal AFTER INSERT ON pg_temp.${prefix}item_reference FOR EACH ROW EXECUTE FUNCTION public.seal_configured_task_candidate();
DO $${prefix}schema$ DECLARE actual_index pg_index;reference_index pg_index;BEGIN
 IF (SELECT count(*) FROM pg_attribute WHERE attrelid='public.episode_extraction_items'::regclass AND attnum>0 AND NOT attisdropped)<>18
  OR EXISTS(SELECT 1 FROM pg_attribute r LEFT JOIN pg_attribute a ON a.attrelid='public.episode_extraction_items'::regclass AND a.attname=r.attname AND NOT a.attisdropped
   WHERE r.attrelid='pg_temp.${prefix}item_reference'::regclass AND r.attname LIKE 'configured_%'
   AND(a.attnum IS NULL OR a.attnum<>r.attnum+13
    OR (to_jsonb(a)-ARRAY['attrelid','attnum','attcacheoff','attoptions']) IS DISTINCT FROM (to_jsonb(r)-ARRAY['attrelid','attnum','attcacheoff','attoptions'])
    -- The managed PostgreSQL build attaches its physical catalog version to
    -- every column. Check every other column option against declared source.
    OR ARRAY(SELECT option FROM unnest(a.attoptions) option WHERE option!~'^pg_attver=[0-9]+$' ORDER BY option)
      IS DISTINCT FROM ARRAY(SELECT option FROM unnest(r.attoptions) option WHERE option!~'^pg_attver=[0-9]+$' ORDER BY option)))
  OR NOT EXISTS(SELECT 1 FROM pg_constraint a JOIN pg_constraint r ON r.conrelid='pg_temp.${prefix}item_reference'::regclass AND r.conname='configured_task_receipt_complete'
   WHERE a.conrelid='public.episode_extraction_items'::regclass AND a.conname=r.conname AND a.contype='c' AND a.convalidated AND a.conenforced
    AND NOT a.condeferrable AND NOT a.condeferred AND pg_get_constraintdef(a.oid) IS NOT DISTINCT FROM pg_get_constraintdef(r.oid))
  OR EXISTS(SELECT 1 FROM pg_trigger r LEFT JOIN pg_trigger a ON a.tgname=r.tgname
   AND a.tgrelid=CASE WHEN r.tgname='configured_task_receipt_guard' THEN 'public.episode_extraction_items'::regclass ELSE 'public.tasks'::regclass END
   WHERE r.tgrelid='pg_temp.${prefix}item_reference'::regclass AND NOT r.tgisinternal
    AND(a.oid IS NULL OR (to_jsonb(a)-ARRAY['oid','tgrelid']) IS DISTINCT FROM (to_jsonb(r)-ARRAY['oid','tgrelid'])))
 THEN RAISE EXCEPTION 'configured_task_receipt_schema_changed';END IF;
 SELECT * INTO actual_index FROM pg_index WHERE indexrelid=to_regclass('public.episode_extraction_items_configured_target');
 SELECT * INTO STRICT reference_index FROM pg_index WHERE indexrelid='pg_temp.${prefix}target_reference'::regclass;
 IF actual_index.indexrelid IS NULL OR actual_index.indrelid<>'public.episode_extraction_items'::regclass
  OR actual_index.indkey::text IS DISTINCT FROM (SELECT attnum::text FROM pg_attribute WHERE attrelid=actual_index.indrelid AND attname='target_record_id')
  OR (to_jsonb(actual_index)-ARRAY['indexrelid','indrelid','indkey','indpred']) IS DISTINCT FROM (to_jsonb(reference_index)-ARRAY['indexrelid','indrelid','indkey','indpred'])
  OR pg_get_expr(actual_index.indpred,actual_index.indrelid) IS DISTINCT FROM pg_get_expr(reference_index.indpred,reference_index.indrelid)
  OR (SELECT relowner FROM pg_class WHERE oid=actual_index.indexrelid) IS DISTINCT FROM (SELECT relowner FROM pg_class WHERE oid='public.workspaces'::regclass)
 THEN RAISE EXCEPTION 'configured_task_target_index_changed';END IF;
END $${prefix}schema$;`
}
export const configuredSchemaCleanup=prefix=>`DROP TABLE pg_temp.${prefix}item_reference;`
export const configuredEnrollSql=`DO $configured_task_enroll$ DECLARE p pg_proc;signature text;BEGIN
 FOREACH signature IN ARRAY ARRAY[${configuredSignatures.map(q).join(',')}] LOOP
  SELECT * INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure('public.'||signature);
  INSERT INTO public.native_turn_contract_helpers VALUES(signature,${executableProjection('p')});
 END LOOP;
END $configured_task_enroll$;`
