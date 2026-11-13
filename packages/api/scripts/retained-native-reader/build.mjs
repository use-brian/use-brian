// [COMP:api/native-chat-read-cost] Deterministic, source-bound forward migration.
import {readFile,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {queryCachePredecessors,queryCacheSource} from './query-cache.mjs'

const directory=new URL('./',import.meta.url)
const target=new URL('../../migrations/8267_retained_native_graph.sql',import.meta.url)
const files=['query-cache.sql','graph.sql','indexed-edges.sql','metadata.sql','capture.sql','cohorts.sql','requirements.sql','scope.sql','publication.sql','reservation.sql','query.sql']
const sources=await Promise.all(files.map(file=>file==='query-cache.sql'?queryCacheSource(historicalSource):readFile(new URL(file,directory),'utf8')))
const predecessors=JSON.parse(await readFile(new URL('predecessors.json',directory),'utf8'))
for(const [name,sha] of Object.entries(queryCachePredecessors)){
 if(!predecessors.some(p=>p.signature.startsWith(`native_turn_compact_${name}(`)&&p.body===sha))throw new Error(`Missing canonical query predecessor pin: ${name}`)
}
const signatures=[]
for(const source of sources)for(const match of source.matchAll(/CREATE(?: OR REPLACE)? FUNCTION (?:public\.)?(\w+)\(([^)]*)\)/g)){
 signatures.push(`${match[1]}(${match[2].split(',').filter(value=>value.trim()).map(value=>value.trim().split(/\s+/)[1]).join(',')})`)
}
signatures.push('native_retained_helpers_current()')
signatures.sort()
const reused=['native_turn_edges(uuid,jsonb)','native_turn_privacy_edges(uuid,jsonb)',
 'native_turn_compact_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb)',
 'native_turn_compact_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb)',
 'native_turn_compact_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb)',
 'native_turn_compact_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)']
const closureSignatures=[...signatures,...reused].sort()
const facadeNames=new Set(['read_native_retained_session_query','read_native_retained_scope_evidence','read_native_retained_publication_cohorts'])
const literal=value=>`'${value.replaceAll("'","''")}'`
const array=values=>`ARRAY[${values.map(literal).join(',')}]::text[]`
// Portable predecessor authentication reuses the reviewed immutable migration
// contracts. Bind only their declared target-local data, never catalog code.
async function historicalSource(file,sha){
 const source=await readFile(new URL(`../../migrations/${file}`,import.meta.url),'utf8')
 if(createHash('sha256').update(source).digest('hex')!==sha)throw new Error(`${file}: portable predecessor source changed`)
 return source
}
const memorySource=await historicalSource('8246_native_private_memory_empty_domain.sql','439f8d2b932d73d47603a874d3b3b02b8c29de801e8aab0c995c65a4d0d4fd3d')
const rosterStart='guard_after constant text:=$native_guard_after$',rosterEnd='$native_guard_after$;'
if(memorySource.split(rosterStart).length!==2)throw new Error('8246: declared predecessor roster changed')
const rosterExpression=memorySource.split(rosterStart)[1].split(rosterEnd)[0]
const nativeRoster=[...rosterExpression.matchAll(/'([^']*)'/g)].map(match=>match[1])
if(nativeRoster.length!==149||new Set(nativeRoster).size!==149||rosterExpression!==array(nativeRoster))throw new Error('8246: invalid declared predecessor roster')
const publicationSource=await historicalSource('8196_native_turn_annotation_publication.sql','45d10e796082730586ba2969a42c0e8d57c0847beca1cff12f9884b308a27a38')
const publicationStart='DO $publication_tables$',publicationEnd='END $publication_tables$;'
if(publicationSource.split(publicationStart).length!==2||publicationSource.split(publicationEnd).length!==2)throw new Error('8196: publication predecessor contract changed')
const publicationBootstrap=publicationStart+publicationSource.split(publicationStart)[1].split(publicationEnd)[0]+publicationEnd
const guard=`CREATE FUNCTION native_retained_helpers_current() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $guard$
 SELECT native_turn_helpers_current() AND EXISTS(SELECT 1 FROM pg_class r WHERE r.oid='native_retained_contract_helpers'::regclass
  AND r.relkind='r' AND r.relpersistence='p' AND r.relrowsecurity AND NOT r.relforcerowsecurity
  AND r.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(r.relacl,acldefault('r',r.relowner))) a WHERE a.grantee<>r.relowner OR a.grantor<>r.relowner)
  AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=r.oid)
  AND (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute WHERE attrelid=r.oid AND attnum>0 AND NOT attisdropped)=ARRAY['signature','fingerprint']
  AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=r.oid AND attnum>0 AND NOT attisdropped AND (atttypid<>'text'::regtype OR NOT attnotnull)))
 AND array_agg(h.signature ORDER BY h.signature)=${array(closureSignatures)}
 AND bool_and(p.oid IS NOT NULL AND h.fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex'))
 FROM native_retained_contract_helpers h LEFT JOIN pg_proc p ON p.oid=to_regprocedure('public.'||h.signature)
$guard$;`
const fingerprintTest=`(SELECT count(*)=1 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='__RETAINED_GUARD_FINGERPRINT__'),false)
 FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_retained_helpers_current()'))`
const fence=` IF ${fingerprintTest} IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;\n`
const generated=sources.map((source,index)=>{
 source=source.replaceAll('CREATE OR REPLACE FUNCTION','CREATE FUNCTION')
 if(['capture.sql','cohorts.sql','requirements.sql','scope.sql','publication.sql','query.sql'].includes(files[index])){
  source=source.replace('BEGIN\n',()=>`BEGIN\n${fence}`)
  // Separate statements authenticate code before invoking a guard. Boolean
  // expression evaluation order must never be used as the trust boundary.
  source=source.replaceAll(' IF native_retained_helpers_current()',`${fence} IF native_retained_helpers_current()`)
  if(files[index]==='query.sql')source=source.replace(" SELECT read_native_retained_requirements(w,roots,'[]'::jsonb) INTO fresh;",()=>`${fence} SELECT read_native_retained_requirements(w,roots,'[]'::jsonb) INTO fresh;`)
 }
 return source.trimEnd().replace(/;?$/, ';')+'\n'
}).join('\n')
const dispatches=(await Promise.all(['canonical-edges.sql','dispatch-publication.sql','dispatch-requirements.sql'].map(file=>readFile(new URL(file,directory),'utf8')))).map(source=>source.trimEnd().replace(/;?$/, ';')).join('\n')
const migration=`-- [COMP:api/native-chat-read-cost] Lossless retained native DAG acquisition.
-- Source templates: scripts/retained-native-reader/. Regenerate with build.mjs.
-- No historical message, annotation, policy or observation is rewritten.
BEGIN;
DO $retained_install$
DECLARE expected jsonb;actual pg_proc;prior jsonb:='{}';routine_signature text;old_row jsonb;guard_fingerprint text;changed integer;ok boolean;
 declared_roster text;declared_native_members constant text[]:=${array(nativeRoster)};
 owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);
BEGIN
 -- Authenticate the executable root before invoking its protected closed
 -- predecessor contract. Catalog hashes include metadata and effective ACLs.
 FOR expected IN SELECT value FROM jsonb_array_elements(${literal(JSON.stringify(predecessors))}::jsonb) LOOP
  SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure('public.'||(expected->>'signature'));
  IF actual.oid IS NULL
   OR (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','pronamespace','prolang','proacl']) IS DISTINCT FROM expected->'metadata'
   OR (expected->>'signature' NOT IN('native_turn_helpers_current()','native_turn_publication_contract()')
    AND encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex') IS DISTINCT FROM expected->>'body')
   OR actual.proowner IS DISTINCT FROM owner_id OR actual.pronamespace<>'public'::regnamespace
   OR actual.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'] OR NOT actual.prosecdef
   OR actual.proisstrict OR actual.proparallel<>'u'
   OR actual.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname=expected->>'language')
   OR actual.provolatile IS DISTINCT FROM (expected->>'volatility')::"char"
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
    WHERE a.grantee<>owner_id OR a.grantor<>owner_id OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
  THEN RAISE EXCEPTION 'retained_reader_predecessor_changed: %',expected->>'signature';END IF;
  IF expected->>'signature'='native_turn_helpers_current()' THEN
   -- 8246 enrolls the exact reviewed roster in the target collation. Only
   -- that single complete literal varies; every other body byte is pinned.
   IF expected->>'bodyTemplate' IS DISTINCT FROM '803d9cd34a7c94347e32172c77ea7387d5cb8e642f905ca08f7f18b796451255'
    OR cardinality(declared_native_members)<>149
    OR (SELECT count(DISTINCT member) FROM unnest(declared_native_members) member)<>149
   THEN RAISE EXCEPTION 'retained_reader_native_roster_changed';END IF;
   SELECT 'ARRAY['||string_agg(quote_literal(member),',' ORDER BY member)||']::text[]' INTO declared_roster
    FROM unnest(declared_native_members) member;
   IF (length(actual.prosrc)-length(replace(actual.prosrc,declared_roster,'')))/length(declared_roster)<>1
    OR encode(sha256(convert_to(replace(actual.prosrc,declared_roster,'__ROSTER__'),'UTF8')),'hex') IS DISTINCT FROM expected->>'bodyTemplate'
   THEN RAISE EXCEPTION 'retained_reader_predecessor_changed: %',expected->>'signature';END IF;
  ELSIF expected->>'signature'='native_turn_publication_contract()'
   AND expected->>'bodyTemplate' IS DISTINCT FROM 'publication-tables-8196' THEN
   RAISE EXCEPTION 'retained_reader_publication_template_changed';
  END IF;
  prior:=prior||jsonb_build_object(expected->>'signature',to_jsonb(actual));
 END LOOP;
 -- This is known checksum-bound SQL, not prosrc obtained from the catalog.
 -- Its original strict table/default/FK/trigger checks precede reconstructing
 -- the complete comparator body with local catalog data and exactly two pins.
 EXECUTE $retained_publication_predecessor$${publicationBootstrap}$retained_publication_predecessor$;
 IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_predecessor_contract_changed';END IF;
 FOREACH routine_signature IN ARRAY ARRAY['native_turn_helpers_current()','native_turn_publication_contract()',
  'application_native_worklist_helpers_current()','application_native_dependency_batch_helpers_current()',
  'application_native_field_reference_helpers_current()','application_memory_statement_helpers_current()'] LOOP
  EXECUTE 'SELECT public.'||routine_signature INTO ok;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_predecessor_guard_changed: %',routine_signature;END IF;
 END LOOP;
 EXECUTE $registry$
  CREATE TABLE native_retained_contract_helpers(signature text PRIMARY KEY,fingerprint text NOT NULL);
  ALTER TABLE native_retained_contract_helpers ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON native_retained_contract_helpers FROM PUBLIC;
 $registry$;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN REVOKE ALL ON native_retained_contract_helpers FROM app_user;END IF;
 EXECUTE $new_guard$${guard}$new_guard$;
 REVOKE ALL ON FUNCTION native_retained_helpers_current() FROM PUBLIC;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN REVOKE ALL ON FUNCTION native_retained_helpers_current() FROM app_user;END IF;
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO guard_fingerprint FROM pg_proc p
 WHERE p.oid='public.native_retained_helpers_current()'::regprocedure;
 EXECUTE replace($new_readers$${generated}$new_readers$,'__RETAINED_GUARD_FINGERPRINT__',guard_fingerprint);
 FOREACH routine_signature IN ARRAY ${array(signatures)} LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC',routine_signature);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM app_user',routine_signature);END IF;
  IF split_part(routine_signature,'(',1)=ANY(${array([...facadeNames])}) AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO app_user',routine_signature);
  END IF;
 END LOOP;
 -- Change the canonical metadata projection and two authenticated dispatchers. All writer/seal/deferred
 -- publication and RLS implementations retain their original bodies.
 EXECUTE replace($dispatches$${dispatches}$dispatches$,'__RETAINED_GUARD_FINGERPRINT__',guard_fingerprint);
 FOREACH routine_signature IN ARRAY ARRAY['native_turn_edges(uuid,jsonb)','native_turn_prepare_publication(uuid,uuid,text,jsonb,jsonb)','read_native_turn_requirements(uuid,jsonb)'] LOOP
  old_row:=prior->routine_signature;
  SELECT * INTO STRICT actual FROM pg_proc WHERE oid=to_regprocedure('public.'||routine_signature);
  IF to_jsonb(actual)-'prosrc' IS DISTINCT FROM old_row-'prosrc' THEN RAISE EXCEPTION 'retained_reader_dispatch_metadata_changed: %',routine_signature;END IF;
  UPDATE native_turn_contract_helpers h SET fingerprint=encode(sha256(convert_to(to_jsonb(actual)::text,'UTF8')),'hex')
   WHERE h.signature=routine_signature AND h.fingerprint=encode(sha256(convert_to(old_row::text,'UTF8')),'hex');
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 THEN RAISE EXCEPTION 'retained_reader_dispatch_predecessor_changed: %',routine_signature;END IF;
 END LOOP;
 FOREACH routine_signature IN ARRAY ${array(closureSignatures)} LOOP
  SELECT * INTO STRICT actual FROM pg_proc WHERE oid=to_regprocedure('public.'||routine_signature);
  IF actual.proowner<>owner_id OR actual.pronamespace<>'public'::regnamespace
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
    WHERE a.grantor<>owner_id OR a.privilege_type<>'EXECUTE' OR a.is_grantable
     OR a.grantee<>owner_id AND NOT(split_part(routine_signature,'(',1)=ANY(${array([...facadeNames])}) AND a.grantee=(SELECT oid FROM pg_roles WHERE rolname='app_user')))
  THEN RAISE EXCEPTION 'retained_reader_install_acl_changed: %',routine_signature;END IF;
  INSERT INTO native_retained_contract_helpers VALUES(routine_signature,encode(sha256(convert_to(to_jsonb(actual)::text,'UTF8')),'hex'));
 END LOOP;
 IF native_retained_helpers_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'retained_reader_install_contract_changed' USING DETAIL=jsonb_build_object(
   'native',native_turn_helpers_current(),
   'rows',(SELECT count(*) FROM native_retained_contract_helpers),
   'changed',(SELECT jsonb_agg(h.signature) FROM native_retained_contract_helpers h LEFT JOIN pg_proc p ON p.oid=to_regprocedure('public.'||h.signature)
     WHERE p.oid IS NULL OR h.fingerprint IS DISTINCT FROM encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),
   'shape',(SELECT jsonb_build_object('owner',r.relowner=owner_id,'rls',r.relrowsecurity,'force',r.relforcerowsecurity,
     'columns',(SELECT jsonb_agg(jsonb_build_array(attname,atttypid::regtype,attnotnull) ORDER BY attnum) FROM pg_attribute WHERE attrelid=r.oid AND attnum>0 AND NOT attisdropped)) FROM pg_class r WHERE r.oid='native_retained_contract_helpers'::regclass))::text;
 END IF;
 FOREACH routine_signature IN ARRAY ARRAY['native_turn_helpers_current()','native_turn_publication_contract()',
  'application_native_worklist_helpers_current()','application_native_dependency_batch_helpers_current()',
  'application_native_field_reference_helpers_current()','application_memory_statement_helpers_current()'] LOOP
  EXECUTE 'SELECT public.'||routine_signature INTO ok;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_successor_guard_changed: %',routine_signature;END IF;
 END LOOP;
END $retained_install$;
COMMIT;
`
if(process.argv.includes('--check')){
 if(await readFile(target,'utf8')!==migration)throw new Error(`Retained migration differs from source templates: ${fileURLToPath(target)}`)
 console.log('Retained migration matches source templates')
}else{await writeFile(target,migration);console.log(`Generated ${fileURLToPath(target)}`)}
