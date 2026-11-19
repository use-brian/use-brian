// [COMP:api/conversation-visibility] Bind exact existing owner declarations
// before installing conversation visitor and derivative receiving routines.
import {readFile,writeFile,readdir} from 'node:fs/promises'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {resolve} from 'node:path'
import {currentInstallationAuthenticationSource} from './installation-authentication-8300.mjs'

const literal=value=>"'"+value.replaceAll("'","''")+"'"
const migration=file=>readFile(new URL('../../migrations/'+file,import.meta.url),'utf8')
const template=file=>readFile(new URL(file,import.meta.url),'utf8')
const once=(source,before,after)=>{
 if(source.split(before).length!==2)throw Error('conversation_receiving_source_changed: '+before.slice(0,100))
 return source.replace(before,()=>after)
}
export const receivingOwnerDeclaration=(source,name)=>{
 const match=new RegExp(`^CREATE(?: OR REPLACE)? FUNCTION (?:public\\.)?${name}\\((?:(?!^CREATE(?: OR REPLACE)? FUNCTION)[\\s\\S])*?\\bAS\\s+(\\$[a-z_0-9]*\\$)[\\s\\S]*?\\1;`,'m').exec(source)
 if(!match)throw Error('conversation_receiving_owner_declaration_missing: '+name)
 return match[0]
}

/** The reviewed 8297 ordinary owners and 631/8054 transitive holders. */
export async function buildReceivingOwnerSql({graphPreview=false}={}){
 const [record,messages,context,visitor,dependencies,backfill,appendFloor]=await Promise.all([
  migration('8297_conversation_record_admission.sql'),migration('631_entity_knowledge_derivation.sql'),
  migration('8054_application_persistent_context_revision_evidence.sql'),
  template('conversation-page-visitor.sql'),template('conversation-record-invalidation.sql'),template('conversation-envelope-backfill.sql'),template('conversation-append-floor.sql'),
 ])
 const ordinary=record.split('-- BEGIN REVIEWED CONVERSATION RECORD DEFINITIONS\n')[1]?.split('-- END REVIEWED CONVERSATION RECORD DEFINITIONS')[0]
 if(!ordinary)throw Error('conversation_receiving_record_predecessor_missing')
 const reviewed=[
  {source:ordinary,name:'withdraw_conversation_record_rows',signature:'',change:sql=>once(sql,
   " IF TG_TABLE_NAME='session_messages' THEN\n  IF TG_OP='UPDATE'",
   " IF TG_TABLE_NAME='session_messages' THEN\n  IF TG_OP='INSERT' THEN PERFORM public.quarantine_unadmitted_conversation_append(NEW);END IF;\n  IF TG_OP='UPDATE'")},
  {preview:true,source:ordinary,name:'require_conversation_record_edge',signature:'uuid,uuid,uuid,text',change:sql=>once(sql,
   'PERFORM public.require_conversation_record_current_lineage(w,capture_id,actor,d);',
   'PERFORM public.index_conversation_record_lineage(w,capture_id,actor,one_reader,d);')},
  {source:ordinary,name:'conversation_record_rows',signature:'public.conversation_envelopes,integer,integer,boolean,uuid,boolean',
   change:sql=>once(sql,'    AND octet_length(m.content::text)<=131072)\n  )',`    AND octet_length(m.content::text)<=131072)
   OR (visual AND e.workspace_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.conversation_legacy_page_guest_rows(e,after_sequence,through_sequence) g WHERE g.id=m.id))
  )`)},
  {preview:true,source:messages,name:'hold_scope_descendants',installed:'hold_scope_descendants_before_files',signature:'uuid,text,uuid',
   change:sql=>once(sql,'WHERE workspace_id=target_workspace AND id=ANY(message_ids) AND NOT scope_held;',
    `WHERE workspace_id=target_workspace AND id=ANY(message_ids) AND NOT scope_held
      AND NOT EXISTS(SELECT 1 FROM public.conversation_envelopes e WHERE e.session_id=session_messages.session_id);`)},
  {preview:true,source:context,name:'hold_scope_descendants',predecessor:sql=>once(sql,'SET search_path=pg_catalog,public AS','SET search_path=pg_catalog,public,pg_temp AS'),signature:'uuid,text,uuid',
   change:sql=>once(once(sql,' PERFORM hold_scope_descendants_before_persistent_context(w,k,i);',
    ' PERFORM hold_scope_descendants_before_persistent_context(w,k,i);\n PERFORM public.hold_conversation_record_dependents(w,k,i);'),
    "WHERE r.workspace_id=w AND NOT r.scope_held AND r.id IN(SELECT id FROM descendants WHERE kind='session_context_revision');",
    `WHERE r.workspace_id=w AND NOT r.scope_held AND r.id IN(SELECT id FROM descendants WHERE kind='session_context_revision')
   AND NOT (r.parent_kind IN('turn_frame','message_annotation','session_title')
    AND EXISTS(SELECT 1 FROM public.conversation_envelopes e WHERE e.session_id=r.session_id));`)},
 ]
 // Canonical record selection includes historical Page guest text. The public
 // query consumes it only once, after its independently checked visitor gate.
 const visitorSources=once(visitor,`  SELECT visible.* FROM public.conversation_record_rows(e,0,NULL,false,NULL,true) visible\n  UNION ALL SELECT legacy.* FROM public.conversation_legacy_page_guest_rows(e,0,NULL) legacy`,
  '  SELECT visible.* FROM public.conversation_record_rows(e,0,NULL,false,NULL,true) visible')
 const referenced=reviewed.filter(guard=>graphPreview||!guard.preview).map((guard,index)=>{
  const declared=receivingOwnerDeclaration(guard.source,guard.name),original=guard.predecessor?guard.predecessor(declared):declared
  const name=guard.installed??guard.name,ref=`pg_temp.receiving_owner_${index}`
  const namePattern=new RegExp('^CREATE(?: OR REPLACE)? FUNCTION (?:public\\.)?'+guard.name)
  return{current:'public.'+name+'('+guard.signature+')',reference:ref+'('+guard.signature+')',
   compiler:original.replace(namePattern,'CREATE FUNCTION '+ref),
   successor:guard.change(original).replace(namePattern,'CREATE OR REPLACE FUNCTION public.'+name)}
 })
 return `${referenced.map(guard=>guard.compiler).join('\n')}
DO $conversation_receiving_predecessor$
DECLARE pair record;actual pg_proc;reviewed pg_proc;
 owner_id constant oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);
BEGIN
 FOR pair IN SELECT * FROM (VALUES ${referenced.map(({current,reference})=>`(${literal(current)},${literal(reference)})`).join(',')}) source(installed,reference) LOOP
  SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure(pair.installed);
  SELECT * INTO STRICT reviewed FROM pg_proc WHERE oid=to_regprocedure(pair.reference);
  IF actual.oid IS NULL OR actual.proowner<>owner_id OR actual.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)]
   OR (to_jsonb(actual)-ARRAY['oid','proname','pronamespace','proacl']) IS DISTINCT FROM
    (to_jsonb(reviewed)-ARRAY['oid','proname','pronamespace','proacl']) THEN RAISE EXCEPTION 'conversation_receiving_predecessor_changed: %',pair.installed USING DETAIL=(SELECT jsonb_build_object(
    'fields',array_agg(key), 'acl',actual.proacl, 'actualBodyHash',encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex'),
    'expectedBodyHash',encode(sha256(convert_to(reviewed.prosrc,'UTF8')),'hex'))::text FROM jsonb_each(to_jsonb(actual))
    WHERE key NOT IN('oid','proname','pronamespace','proacl') AND value IS DISTINCT FROM to_jsonb(reviewed)->key);END IF;
 END LOOP;
END $conversation_receiving_predecessor$;
-- BEGIN REVIEWED CONVERSATION RECEIVING OWNERS
${visitorSources}
${graphPreview?dependencies:''}
${backfill}
${appendFloor}
${referenced.map(guard=>guard.successor).join('\n')}
-- END REVIEWED CONVERSATION RECEIVING OWNERS
DROP FUNCTION ${referenced.map(guard=>guard.reference).join(',')};`
}

export const receivingMigrationName='8301_conversation_receiving_owners.sql'
export async function buildReceivingOwnerMigration(){
 const predecessor=await currentInstallationAuthenticationSource()
 const owners=await buildReceivingOwnerSql()
 return `-- [COMP:api/conversation-visibility] Native Page visitors, conversation append admission and bounded envelope backfill.
BEGIN;
DO $receiving_owner_prerequisites$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'conversation_receiving_unreviewed_ddl_trigger';END IF;
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='8300_conversation_record_conversion.sql') THEN
  RAISE EXCEPTION 'conversation_receiving_predecessor_missing';END IF;
END $receiving_owner_prerequisites$;
${predecessor.sql}
${owners}
DO $receiving_owner_witness$ BEGIN
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_turn_publication_contract() IS NOT TRUE OR public.native_retained_helpers_current() IS NOT TRUE
  OR public.native_conversation_conversion_contract() IS NOT TRUE THEN RAISE EXCEPTION 'conversation_receiving_witness_changed';END IF;
END $receiving_owner_witness$;
${predecessor.cleanup}
COMMIT;
`
}

const cli=process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url
if(cli){
 const args=process.argv.slice(2),migrations=fileURLToPath(new URL('../../migrations/',import.meta.url))
 const target=resolve(migrations,receivingMigrationName),sql=await buildReceivingOwnerMigration()
 if(args.length===2&&args[0]==='--candidate')await writeFile(resolve(args[1]),sql,{mode:0o600,flag:'wx'})
 else if(args.length===1&&args[0]==='--check'){
  if(await readFile(target,'utf8')!==sql)throw Error('conversation_receiving_numbered_source_changed')
 }else if(args.length===0){
  const files=await readdir(migrations)
  if(!files.includes('8300_conversation_record_conversion.sql')||files.some(file=>file.startsWith('8301_')))
   throw Error('conversation_receiving_migration_number_occupied')
  await writeFile(target,sql,{flag:'wx'})
 }else throw Error('Use --candidate PATH or --check')
 console.log('Conversation receiving owner source compiled')
}
