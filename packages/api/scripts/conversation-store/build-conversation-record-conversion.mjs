// [COMP:api/conversation-record-conversion] Reviewed conversion protocol extension.
import {readFile,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {currentInstallationAuthenticationSource} from './installation-authentication-8298.mjs'
import {executableProjection} from './executable-record.mjs'
import {witnessRelationCheckSql} from './registry-guard-successor.mjs'

const read=name=>readFile(new URL(name,import.meta.url),'utf8')
const q=value=>"'"+value.replaceAll("'","''")+"'"
const one=(source,original,next,count=1)=>{
 if(source.split(original).length!==count+1)throw Error('record_conversion_preserved_source_changed: '+original)
 return source.replaceAll(original,()=>next)
}

export const number='8300_conversation_record_conversion.sql'
export const conversionRecordSignatures=Object.freeze([
 'protect_compiled_conversation_payload()',
 'conversation_record_conversion_compiler()',
 'enqueue_conversation_record_conversion()',
 'enroll_existing_conversation_records(integer)',
 'enqueue_exact_conversation_record(conversation_envelopes,integer,integer,integer,boolean)',
 'compile_conversation_record_page(integer,integer)',
 'read_compiled_conversation_payload(conversation_envelopes,integer,integer,integer,boolean,uuid,text)',
])

export function conversionRecordRenderer(name,predecessor){
 return `CREATE FUNCTION pg_temp.${name}(routine text,parts jsonb,successor boolean) RETURNS text
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $record_conversion_renderer$
 DECLARE body text:=pg_temp.${predecessor}(routine,parts,successor);
  anchor constant text:='array_agg(h.signature ORDER BY h.signature)=';
  start_at integer;end_at integer;roster text;existing text[];next_roster text;
  new_members constant text[]:=ARRAY[${conversionRecordSignatures.map(q).join(',')}];
 BEGIN
  IF routine<>'native_turn_helpers_current()' THEN RETURN body;END IF;
  IF (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'record_conversion_registry_shape_changed';END IF;
  start_at:=strpos(body,anchor)+length(anchor);end_at:=strpos(substring(body FROM start_at),'::text[]')+start_at-1;
  roster:=substring(body FROM start_at FOR end_at-start_at);
  SELECT array_agg(replace(m[1],'''''','''') ORDER BY o) INTO existing
   FROM regexp_matches(roster,'''((?:[^'']|'''')*)''','g') WITH ORDINALITY x(m,o);
  IF roster IS DISTINCT FROM (SELECT 'ARRAY['||string_agg(quote_literal(s),',' ORDER BY s)||']' FROM unnest(existing) s)
   OR existing&&new_members THEN RAISE EXCEPTION 'record_conversion_registry_roster_changed';END IF;
  SELECT 'ARRAY['||string_agg(quote_literal(s),',' ORDER BY s)||']' INTO next_roster FROM unnest(existing||new_members) s;
  RETURN substring(body FROM 1 FOR start_at-1)||next_roster||substring(body FROM end_at);
 END $record_conversion_renderer$;`
}

export async function legacyConversionBodies(){
 const legacy=await read('../../migrations/8273_conversation_requirement_conversion.sql')
 if(createHash('sha256').update(legacy).digest('hex')!=='5617c736f9abf63b737ffd771479b4dba285c26b905532bf047ed470be9c4996')
  throw Error('record_conversion_legacy_migration_changed')
 const routines=[
  ['page','uuid,integer,integer',body=>one(one(body,
   'WHERE workspace_id=w)',"WHERE workspace_id=w AND kind::text<>'conversation_record')"),
   "WHERE r.phase='delta' AND p.workspace_id=w", "WHERE r.phase='delta' AND p.workspace_id=w AND p.kind::text<>'conversation_record'")],
  ['reconcile','uuid',body=>one(body,
   'WHERE workspace_id=w)',"WHERE workspace_id=w AND kind::text<>'conversation_record')")],
 ]
 return routines.map(([suffix,parameters,transform])=>{
  const name='native_conversation_conversion_'+suffix,signature='('+parameters+')'
  const declaration=legacy.match(new RegExp('^CREATE FUNCTION public\\.'+name+'\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;', 'm'))
  if(!declaration)throw Error('record_conversion_legacy_definition_missing: '+name)
  const reference=declaration[0].replace('public.'+name,'pg_temp.'+name)
  const successor=one(declaration[0],declaration[1],transform(declaration[1])).replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION')
  return {signature,name,reference,successor,body:transform(declaration[1])}
 })
}

export async function buildRecordConversionCandidate({unbound=false}={}){
 const [changes,schema]=await Promise.all([legacyConversionBodies(),read('conversation-record-conversion.sql')])
 const auth=changes.map(({signature,name,reference})=>`${reference}
 DO $record_conversion_legacy_member$
 DECLARE actual pg_proc;expected pg_proc;owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.workspaces'::regclass);
 BEGIN
  SELECT * INTO STRICT actual FROM pg_proc WHERE oid=${q('public.'+name+signature)}::regprocedure;
  SELECT * INTO STRICT expected FROM pg_proc WHERE oid=${q('pg_temp.'+name+signature)}::regprocedure;
  IF actual.proowner<>owner_id OR actual.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)]
   OR (to_jsonb(actual)-ARRAY['oid','pronamespace','proowner','proacl']) IS DISTINCT FROM
      (to_jsonb(expected)-ARRAY['oid','pronamespace','proowner','proacl'])
  THEN RAISE EXCEPTION 'record_conversion_legacy_member_changed: %',${q(name+signature)} USING DETAIL=(
   SELECT coalesce(jsonb_object_agg(key,jsonb_build_array(value,to_jsonb(expected)->key)), '{}'::jsonb)::text
   FROM jsonb_each(to_jsonb(actual)-ARRAY['oid','pronamespace','proowner','proacl'])
   WHERE value IS DISTINCT FROM to_jsonb(expected)->key
  );END IF;
 END $record_conversion_legacy_member$;
 DROP FUNCTION pg_temp.${name}${signature};`).join('\n')
 if(unbound)return `BEGIN;
 ${auth}
 ${schema}
 ${changes.map(change=>change.successor).join('\n')}
 COMMIT;\n`

 const prefix='a8298_',name='record_conversion_successor_body'
 const [predecessor,installer,original,snapshot]=await Promise.all([
  currentInstallationAuthenticationSource(),read('conversion-install.mjs'),read('conversion-original-consumers.sql'),read('conversion-schema-snapshot.sql'),
 ])
 const headerStart=predecessor.sql.indexOf(`CREATE FUNCTION pg_temp.${prefix}publication_relation_semantics(`)
 const headerEnd=predecessor.sql.indexOf('$shape$;',headerStart)
 if(headerStart<0||headerEnd<headerStart)throw Error('record_conversion_relation_semantics_changed')
 const [header]=predecessor.sql.slice(headerStart,headerEnd).split('AS $shape$').slice(1).map(text=>text.trim())
 if(!header?.includes('relation_record'))throw Error('record_conversion_relation_semantics_unavailable')
 const expression=snapshot.replace(/^--.*\n/,'').trim()
  .replaceAll('__CLASS_C__','('+header.replaceAll('relation_record','c')+')')
  .replaceAll('__CLASS_R__','('+header.replaceAll('relation_record','r')+')')
 const owned=['native_conversation_conversion_contract()',...changes.map(routine=>routine.name+routine.signature),'native_turn_helpers_current()']
 const scoped=source=>source.replaceAll('publication_expected_current',prefix+'publication_expected_current')
  .replaceAll('publication_successor_templates',prefix+'publication_successor_templates')
  .replaceAll('pg_temp.conversion_source_body','pg_temp.'+name)
 const consumers=scoped(one(original,"WHERE signature IN('native_turn_helpers_current()','native_turn_publication_contract()');",
  `WHERE signature IN(${owned.map(q).join(',')});`))
 const start=installer.indexOf('DO $conversion_propagate$'),end=installer.indexOf('END $conversion_propagate$;',start)
 if(start<0||end<start)throw Error('record_conversion_propagation_source_changed')
 let propagate=scoped(installer.slice(start,end+'END $conversion_propagate$;'.length))
 propagate=one(propagate,'SET contract=after_row','SET contract='+executableProjection('after_row'))
 propagate=one(propagate,'p IS DISTINCT FROM h.contract',executableProjection('p')+' IS DISTINCT FROM h.contract')
 propagate=one(propagate,'to_jsonb(h.contract) IS DISTINCT FROM expected','h.contract IS DISTINCT FROM '+executableProjection('actual'))
 const expected=prefix+'publication_expected_current',templates=prefix+'publication_successor_templates'
 return `-- [COMP:api/conversation-record-conversion] Bounded exact conversion sources and installation authentication.
BEGIN;
DO $record_conversion_predecessor$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='8298_legacy_bypass_retirement.sql')
  OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
 THEN RAISE EXCEPTION 'record_conversion_predecessor_unavailable';END IF;
END $record_conversion_predecessor$;
${predecessor.sql}
${auth}
${consumers}
${schema}
CREATE TEMP TABLE record_conversion_snapshot(snapshot jsonb NOT NULL) ON COMMIT DROP;
INSERT INTO record_conversion_snapshot ${expression};
DO $record_conversion_source_contract$
DECLARE actual pg_proc;predicate text;next_body text;snapshot jsonb;target text;
 marker constant text:='::jsonb AND'||chr(10)||' (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid)';
 owner_id constant oid:=(SELECT relowner FROM pg_class WHERE oid='public.workspaces'::regclass);
BEGIN
 SELECT * INTO STRICT actual FROM pg_proc WHERE oid='public.native_conversation_conversion_contract()'::regprocedure;
 IF (length(actual.prosrc)-length(replace(actual.prosrc,marker,'')))/length(marker)<>1
 THEN RAISE EXCEPTION 'record_conversion_table_contract_source_changed';END IF;
 predicate:=substring(actual.prosrc FROM strpos(actual.prosrc,marker));
 SELECT source.snapshot INTO STRICT snapshot FROM pg_temp.record_conversion_snapshot source;
 next_body:=chr(10)||' SELECT ('||${q(expression)}||') IS NOT DISTINCT FROM '||quote_literal(snapshot::text)||predicate;
 UPDATE pg_temp.${templates} SET parts=jsonb_build_array(next_body) WHERE signature='native_conversation_conversion_contract()';
 IF NOT FOUND THEN RAISE EXCEPTION 'record_conversion_table_contract_missing';END IF;
 FOREACH target IN ARRAY ARRAY[${conversionRecordSignatures.map(q).join(',')}] LOOP
  SELECT * INTO STRICT actual FROM pg_proc WHERE oid=to_regprocedure('public.'||target);
  IF actual.proowner<>owner_id OR actual.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)]
    OR EXISTS(SELECT 1 FROM public.native_turn_contract_helpers WHERE signature=target)
  THEN RAISE EXCEPTION 'record_conversion_new_member_changed: %',target;END IF;
  INSERT INTO public.native_turn_contract_helpers VALUES(target,${executableProjection('actual')});
  INSERT INTO pg_temp.${expected} VALUES(target,to_jsonb(actual));
  INSERT INTO pg_temp.${templates} VALUES(target,jsonb_build_array(actual.prosrc));
 END LOOP;
END $record_conversion_source_contract$;
${changes.map(({name,signature,body})=>`UPDATE pg_temp.${templates} SET parts=jsonb_build_array(${q(body)}) WHERE signature=${q(name+signature)};`).join('\n')}
${conversionRecordRenderer(name,prefix+'conversion_source_body')}
${propagate}
SELECT public.native_turn_contract_witness_refresh();
${witnessRelationCheckSql('record_conversion_')}
${predecessor.cleanup}
DROP FUNCTION pg_temp.${name}(text,jsonb,boolean);
COMMIT;\n`
}

const program=process.argv[1]
if(program&&program===fileURLToPath(import.meta.url)){
 const [, ,flag,path]=process.argv
 if(!['--candidate','--candidate-unbound','--check','--write-numbered'].includes(flag)||flag.startsWith('--candidate')!==Boolean(path))
  throw Error('Use --candidate PATH, --check or --write-numbered')
 const sql=await buildRecordConversionCandidate({unbound:flag==='--candidate-unbound'})
 const output=path??new URL('../../migrations/'+number,import.meta.url)
 if(flag==='--check'){
  const numbered=await readFile(output,'utf8')
  if(numbered!==sql)throw Error('record_conversion_numbered_source_changed')
 }else await writeFile(output,sql,{mode:0o600,...(flag==='--write-numbered'?{flag:'wx'}:{})})
}
