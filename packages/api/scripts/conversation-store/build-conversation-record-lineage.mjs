// [COMP:api/conversation-visibility] Source-bound downstream and anchor owners.
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { currentInstallationAuthenticationSource } from './installation-authentication-8307.mjs'
import { executableProjection } from './executable-record.mjs'

export const lineageMigrationName = '8309_conversation_record_lineage.sql'
export const lineageSectionStart = '-- BEGIN REVIEWED CONVERSATION RECORD LINEAGE\n'
export const lineageSectionEnd = '-- END REVIEWED CONVERSATION RECORD LINEAGE'
export const lineageMediaSignature = 'media_parent_visible(text,uuid)'
const literal=value=>"'"+value.replaceAll("'","''")+"'"
function once(source,before,after) {
  if(source.split(before).length!==2)throw Error('conversation_lineage_predecessor_source_changed: '+before.slice(0,75))
  return source.replace(before,()=>after)
}

export function lineageMediaRenderer(name,previous) {
  const before="   snapshot:=read_media_parent_snapshot(w,item->>'kind',(item->>'id')::uuid);"
  const after=`   IF item->>'kind'='conversation_record' THEN
    IF item->>'version' IS DISTINCT FROM '1' OR public.conversation_record_member_allowed(w,(item->>'id')::uuid,
     nullif(current_setting('app.current_user_id',true),'')::uuid) IS NOT TRUE THEN RETURN false; END IF;
    snapshot:=public.read_conversation_record_source(w,(item->>'id')::uuid);
   ELSE
${before}
   END IF;`
  return `CREATE FUNCTION pg_temp.${name}(routine text,parts jsonb,successor boolean) RETURNS text
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $record_lineage_renderer$
 DECLARE body text:=pg_temp.${previous}(routine,parts,successor);marker constant text:=${literal(before)};
 BEGIN
  IF routine=${literal(lineageMediaSignature)} THEN
   IF (length(body)-length(replace(body,marker,'')))/length(marker)<>1 THEN
    RAISE EXCEPTION 'conversation_lineage_media_predecessor_changed';END IF;
   body:=replace(body,marker,${literal(after)});
  END IF;
  RETURN body;
 END $record_lineage_renderer$;`
}

async function mediaSuccessor() {
  const prefix='a8307_',renderer='record_lineage_successor_body'
  const [consumers,installer]=await Promise.all(['conversion-original-consumers.sql','conversion-install.mjs']
    .map(file=>readFile(new URL(file,import.meta.url),'utf8')))
  const configure=source=>source.replaceAll('publication_expected_current',prefix+'publication_expected_current')
    .replaceAll('publication_successor_templates',prefix+'publication_successor_templates')
    .replaceAll('pg_temp.conversion_source_body','pg_temp.'+renderer)
  const start=installer.indexOf('DO $conversion_propagate$'),end=installer.indexOf('END $conversion_propagate$;',start)
  if(start<0||end<start)throw Error('conversation_lineage_propagation_source_changed')
  let propagate=configure(installer.slice(start,end+'END $conversion_propagate$;'.length))
  propagate=once(propagate,'SET contract=after_row','SET contract='+executableProjection('after_row'))
  propagate=once(propagate,'p IS DISTINCT FROM h.contract',executableProjection('p')+' IS DISTINCT FROM h.contract')
  propagate=once(propagate,'to_jsonb(h.contract) IS DISTINCT FROM expected','h.contract IS DISTINCT FROM '+executableProjection('actual'))
  return [
    configure(once(consumers,"WHERE signature IN('native_turn_helpers_current()','native_turn_publication_contract()');",
      'WHERE signature IN('+literal(lineageMediaSignature)+');')),
    lineageMediaRenderer(renderer,prefix+'conversion_source_body'),propagate,
    'DROP FUNCTION pg_temp.'+renderer+'(text,jsonb,boolean);',
  ].join('\n')
}

export async function reviewedLineageSource() {
  return (await Promise.all([
    'conversation-record-downstream-read.sql',
    'conversation-record-downstream-mount.sql',
    'conversation-anchor-write-admission.sql',
  ].map(file => readFile(new URL(file,import.meta.url),'utf8')))).join('\n')
}

export async function buildConversationRecordLineageCandidate() {
  const [previous,lineage,media]=await Promise.all([currentInstallationAuthenticationSource(),reviewedLineageSource(),mediaSuccessor()])
  return `-- [COMP:api/conversation-visibility] Current authority for retained native derivatives and anchor-bound writes.
BEGIN;
DO $lineage_predecessor$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'conversation_lineage_unreviewed_ddl_trigger';END IF;
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='8307_conversation_record_floor.sql') THEN
  RAISE EXCEPTION 'conversation_lineage_predecessor_missing';END IF;
 IF to_regprocedure('public.conversation_visibility_settings_ready()') IS NOT NULL THEN
  RAISE EXCEPTION 'conversation_settings_readiness_source_changed';END IF;
END $lineage_predecessor$;
${previous.sql}
${lineageSectionStart}${lineage}${lineageSectionEnd}
${media}
DO $lineage_witness$ BEGIN
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_turn_publication_contract() IS NOT TRUE OR public.native_retained_helpers_current() IS NOT TRUE
  OR public.native_conversation_conversion_contract() IS NOT TRUE THEN RAISE EXCEPTION 'conversation_lineage_witness_changed';END IF;
END $lineage_witness$;
${previous.cleanup}
COMMIT;\n`
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const [mode,target,...rest]=process.argv.slice(2)
  const directory=new URL('../../migrations/',import.meta.url),migration=new URL(lineageMigrationName,directory)
  const sql=await buildConversationRecordLineageCandidate()
  if(mode==='--candidate'&&target&&!rest.length) {
    await writeFile(resolve(target),sql,{mode:0o600,flag:'wx'})
  } else if(mode==='--check'&&!target) {
    if(await readFile(migration,'utf8')!==sql)throw Error('conversation_lineage_numbered_source_changed')
  } else if(!mode) {
    const hosted=new URL('../../../../../packages/api-platform/migrations/',import.meta.url)
    const both=(await Promise.all([readdir(directory),readdir(hosted)])).flat()
    if(both.some(file=>file.startsWith('8309_')))throw Error('conversation_lineage_migration_number_occupied')
    await writeFile(migration,sql,{flag:'wx'})
  } else {
    throw Error('Use --candidate PATH or --check')
  }
}
