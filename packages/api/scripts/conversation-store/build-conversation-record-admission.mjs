// [COMP:api/conversation-visibility] Compile the native record successor from
// reviewed source against the frozen 8296 executable profile.
import {readFile,writeFile,readdir} from 'node:fs/promises'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {resolve} from 'node:path'
import {currentInstallationAuthenticationSource} from './installation-authentication-8296.mjs'
import {executableProjection} from './executable-record.mjs'
import {recordPublicationChanges,recordPublicationConstraintSql,recordPublicationRendererSql} from './conversation-record-publication.mjs'
import {buildConversationSettingsSuccessor} from './conversation-settings-successor.mjs'

const read=name=>readFile(new URL(name,import.meta.url),'utf8')
const literal=value=>"'"+value.replaceAll("'","''")+"'"
const once=(source,from,to)=>{
 if(source.split(from).length!==2)throw Error('conversation_record_renderer_input_changed: '+from)
 return source.replace(from,()=>to)
}
export async function buildRecordAdmissionCandidate(){
 const [predecessor,authority,enrollment,record,admission,derivation,nativeReads,readPolicies,nativeTitles,settings,settingsSuccessor,installer,original]=await Promise.all([
  currentInstallationAuthenticationSource(),read('conversation-authority.sql'),read('conversation-legacy-enrollment.sql'),
  read('conversation-record.sql'),read('conversation-record-admission.sql'),read('conversation-record-derivation.sql'),
  read('conversation-native-reads.sql'),read('conversation-read-policies.sql'),read('conversation-native-titles.sql'),
  read('conversation-visibility-settings.sql'),buildConversationSettingsSuccessor(),
  read('conversion-install.mjs'),read('conversion-original-consumers.sql'),
 ])
 const prefix='a8296_',signatures=Object.keys(recordPublicationChanges)
 const expected=prefix+'publication_expected_current',templates=prefix+'publication_successor_templates'
 const pinConsumers=once(original,"WHERE signature IN('native_turn_helpers_current()','native_turn_publication_contract()');",
  `WHERE signature IN(${signatures.map(literal).join(',')});`)
  .replaceAll('publication_expected_current',expected).replaceAll('publication_successor_templates',templates)
 const propagationStart=installer.indexOf('DO $conversion_propagate$')
 const propagationEnd=installer.indexOf('END $conversion_propagate$;')
 if(propagationStart<0||propagationEnd<propagationStart)throw Error('conversation_record_propagation_source_changed')
 let propagation=installer.slice(propagationStart,propagationEnd+'END $conversion_propagate$;'.length)
 propagation=propagation.replaceAll('publication_expected_current',expected).replaceAll('publication_successor_templates',templates)
  .replaceAll('pg_temp.conversion_source_body','pg_temp.record_publication_source_body')
 propagation=once(propagation,'SET contract=after_row',`SET contract=${executableProjection('after_row')}`)
 propagation=once(propagation,'p IS DISTINCT FROM h.contract',executableProjection('p')+' IS DISTINCT FROM h.contract')
 // The current registry uses the canonical executable projection (volatile
 // engine estimates have no authority), unlike the earlier 8273 projection.
 propagation=once(propagation,'to_jsonb(h.contract) IS DISTINCT FROM expected',
  `h.contract IS DISTINCT FROM ${executableProjection('actual')}`)
 propagation=once(propagation,"RAISE EXCEPTION 'conversion_successor_contract_changed';",
  `RAISE EXCEPTION 'conversation_record_successor_contract_changed' USING DETAIL=(SELECT jsonb_build_object(
  'expected',(SELECT jsonb_agg(e.signature) FROM ${expected} e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature) WHERE to_jsonb(p) IS DISTINCT FROM e.metadata),
  'registry',(SELECT jsonb_agg(h.signature) FROM native_turn_contract_helpers h LEFT JOIN pg_proc p ON p.oid=to_regprocedure(h.signature) WHERE ${executableProjection('p')} IS DISTINCT FROM h.contract),
  'conversion',native_conversation_conversion_contract(),'current',native_turn_helpers_current(),
  'publication',native_turn_publication_contract(),'retained',native_retained_helpers_current(),
  'retainedMembers',(SELECT jsonb_agg(h.signature) FROM native_retained_contract_helpers h
   LEFT JOIN pg_proc p ON p.oid=to_regprocedure(h.signature)
   WHERE h.fingerprint IS DISTINCT FROM encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')))::text);`)
 return `-- [COMP:api/conversation-visibility] Canonical conversation record admission and same-conversation publication.
BEGIN;
DO $record_admission_prerequisites$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'conversation_record_unreviewed_ddl_trigger';END IF;
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='8296_configured_task_publication.sql') THEN
  RAISE EXCEPTION 'conversation_record_predecessor_missing';END IF;
END $record_admission_prerequisites$;
${predecessor.sql}
DO $record_publication_original$ BEGIN
 IF (SELECT count(*) FROM pg_temp.${templates} WHERE signature IN(${signatures.map(literal).join(',')}))<>${signatures.length}
 THEN RAISE EXCEPTION 'conversation_record_publication_template_missing';END IF;
END $record_publication_original$;
${pinConsumers}
-- BEGIN REVIEWED CONVERSATION RECORD DEFINITIONS
${authority}
${enrollment}
${record}
${admission}
${derivation}
${nativeReads}
${readPolicies}
${nativeTitles}
${settings}
${settingsSuccessor}
-- END REVIEWED CONVERSATION RECORD DEFINITIONS
${recordPublicationConstraintSql()}
${recordPublicationRendererSql('record_publication_source_body',prefix+'conversion_source_body')}
${propagation}
DO $record_admission_witness$ BEGIN
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE THEN RAISE EXCEPTION 'conversation_record_witness_refresh_failed';END IF;
END $record_admission_witness$;
-- BEGIN REVIEWED CONVERSATION RECORD ACL
GRANT EXECUTE ON FUNCTION public.capture_native_turn_conversation_record(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean,uuid,integer,integer,integer),
 public.admit_native_turn_conversation_records(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean,uuid,text,uuid[],text[]),
 public.capture_native_conversation_record(uuid,uuid,uuid,integer,integer,integer,integer),
 public.read_conversation_member_tiers(uuid[],boolean),
 public.read_conversation_visibility(uuid,uuid,integer),public.change_conversation_visibility(uuid,uuid,integer,bigint,text,jsonb),
 public.raise_conversation_cap(uuid,uuid,integer,bigint,text),public.move_conversation_project(uuid,uuid,integer,bigint,uuid),
 public.promote_native_conversation_legacy_history(uuid,uuid,integer,bigint) TO app_user;
-- END REVIEWED CONVERSATION RECORD ACL
DROP FUNCTION pg_temp.record_publication_source_body(text,jsonb,boolean);
${predecessor.cleanup}
COMMIT;
`
}

const entry=process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url
if(entry){
 const name='8297_conversation_record_admission.sql',migrations=fileURLToPath(new URL('../../migrations/',import.meta.url))
 const target=resolve(migrations,name),args=process.argv.slice(2)
 if(args.length&&!(args.length===1&&args[0]==='--check')&&!(args.length===2&&args[0]==='--candidate'))
  throw Error('Use --candidate PATH to verify a disposable build, or --check to verify the numbered migration')
 const sql=await buildRecordAdmissionCandidate()
 if(args[0]==='--check'){
  if(await readFile(target,'utf8')!==sql)throw Error('conversation_record_generated_migration_changed')
  console.log('Canonical conversation record migration matches source')
 }else if(args[0]==='--candidate'){
  await writeFile(resolve(args[1]),sql,{mode:0o600});console.log('Wrote record admission candidate',resolve(args[1]))
 }else{
  const files=await readdir(migrations)
  if(!files.includes('8296_configured_task_publication.sql')||files.some(file=>file.startsWith('8297_')))
   throw Error('conversation_record_migration_number_occupied')
  await writeFile(target,sql,{flag:'wx'});console.log('Wrote canonical conversation record migration',target)
 }
}
