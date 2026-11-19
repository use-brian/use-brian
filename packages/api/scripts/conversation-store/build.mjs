// [COMP:api/native-turn-frame] Authenticated, reproducible forward replacement.
import {readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
const directory=new URL('./',import.meta.url),target=new URL('../../migrations/8269_canonical_conversation_publication.sql',import.meta.url)
const hash=value=>createHash('sha256').update(value).digest('hex')
const literal=value=>`'${value.replaceAll("'","''")}'`
const array=values=>`ARRAY[${values.map(literal).join(',')}]::text[]`
const previous=await readFile(new URL('../../migrations/8267_retained_native_graph.sql',import.meta.url),'utf8')
if(hash(previous)!=='b103fe26e4aaeaff237eff6e156a32907ed5b76c967e76c9276f60ee5918ad71')throw new Error('Retained predecessor source changed')
// Reuse only the checksum-bound predecessor authentication, not its installation.
let authenticate=previous.slice(previous.indexOf('DO $retained_install$'),previous.indexOf(' EXECUTE $registry$'))
const before=JSON.parse(await readFile(new URL('reader-predecessors.json',directory),'utf8'))
const rosterStart=authenticate.indexOf('jsonb_array_elements(')+'jsonb_array_elements('.length
const rosterEnd=authenticate.indexOf('::jsonb)',rosterStart)
if(rosterStart<'jsonb_array_elements('.length||rosterEnd<rosterStart)throw new Error('Retained predecessor roster changed')
const predecessorLiteral=authenticate.slice(rosterStart,rosterEnd)
if(before.length!==2||!before.every(p=>['native_turn_helpers_current()','native_turn_publication_contract()'].includes(p.signature)))throw new Error('Canonical predecessor roster changed')
authenticate=authenticate.replace(predecessorLiteral,literal(JSON.stringify(before)))
// Authenticate the two legacy flat comparators from their immutable template.
// Their exact catalog rows are data; the comparator executable is fixed.
authenticate=authenticate.slice(0,authenticate.indexOf(' FOREACH routine_signature IN ARRAY'))+'END $retained_install$;\n'
const flatSource=await readFile(new URL('../../migrations/81942_legacy_dependency_acl_snapshots.sql',import.meta.url),'utf8')
if(hash(flatSource)!=='b97af9b3d82be7712a5bbda9cb78e042abc77a9fc2c0723f5623ba66dc463a14')throw new Error('Flat predecessor source changed')
const lines=flatSource.split('\n'),range=(a,b)=>lines.slice(a-1,b).join('\n')
const flatAuthentication=`DO $flat_authentication$
${range(10,16)}
BEGIN
${range(21,69)}
${range(73,81)}
 IF actual.prosrc IS DISTINCT FROM body THEN RAISE EXCEPTION 'conversation_flat_predecessor_changed: dependency';END IF;
${range(114,141)}
${range(145,153)}
 IF actual.prosrc IS DISTINCT FROM body THEN RAISE EXCEPTION 'conversation_flat_predecessor_changed: reference';END IF;
END $flat_authentication$;`

// The old media facade carried five additional permission dependencies in its
// body. Transfer those authenticated contracts to the canonical registry before
// retiring that facade; otherwise its leaf readers could drift unnoticed.
const mediaSource=await readFile(new URL('../../migrations/8262_native_media_admission_dependency.sql',import.meta.url),'utf8')
const mediaDependencies=JSON.parse(mediaSource.split('$media_dependencies$')[1])
const mediaAuthentication=mediaSource.slice(mediaSource.indexOf('  SELECT * INTO STRICT dependency'),mediaSource.indexOf('  pins:=pins'))
 .replaceAll('routine.proowner','owner_id')
const mediaRegistry=`DO $conversation_media_contract$ DECLARE expected jsonb;dependency pg_proc;owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='sessions'::regclass);BEGIN
 FOR expected IN SELECT value FROM jsonb_array_elements(${literal(JSON.stringify(mediaDependencies))}::jsonb) LOOP
${mediaAuthentication}
 INSERT INTO native_turn_contract_helpers(signature,fingerprint) VALUES(expected->>'signature',encode(sha256(convert_to(to_jsonb(dependency)::text,'UTF8')),'hex'));
 END LOOP;
END $conversation_media_contract$;`

// Transfer the authenticated flat-reader leaf contracts into the one canonical
// registry. Ordinary captures no longer execute three overlapping comparators.
const readerContractTransfer=`
CREATE TEMP TABLE conversation_reader_contract_members(oid oid PRIMARY KEY) ON COMMIT DROP;
DO $reader_contract_transfer$ DECLARE body text;signature text;members oid[];pin record;tail constant text:=' JOIN pg_catalog.pg_proc p ON p.oid=m.oid);END';BEGIN
 IF application_native_worklist_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'conversation_reader_contract_changed';END IF;
 SELECT prosrc INTO STRICT body FROM pg_proc WHERE oid='application_memory_statement_helpers_current()'::regprocedure;
 IF strpos(body,' FROM (VALUES ')=0 OR right(body,length(tail))<>tail THEN RAISE EXCEPTION 'conversation_memory_contract_shape';END IF;
 EXECUTE 'SELECT array_agg(m.oid) '||substring(left(body,length(body)-length(tail)) FROM strpos(body,'FROM (VALUES ')) INTO members;
 IF cardinality(members)<>128 THEN RAISE EXCEPTION 'conversation_memory_contract_roster';END IF;
 INSERT INTO conversation_reader_contract_members SELECT unnest(members);
 FOREACH signature IN ARRAY ARRAY['application_native_worklist_helpers_current()','application_empty_query_helpers_current()'] LOOP
  SELECT prosrc INTO STRICT body FROM pg_proc WHERE oid=to_regprocedure(signature);
  IF signature='application_empty_query_helpers_current()' AND
   regexp_replace(body,$pattern$\\(([0-9]+)::oid,'([a-f0-9]{64})'::text\\)$pattern$,'__PIN__','g') IS DISTINCT FROM
   $empty$SELECT application_memory_statement_helpers_current() AND (SELECT count(*)=4 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')=pin.fingerprint),false)
    FROM (VALUES __PIN__,__PIN__,__PIN__,__PIN__) pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid)$empty$
  THEN RAISE EXCEPTION 'conversation_empty_contract_shape';END IF;
  members:='{}';
  FOR pin IN SELECT match[1]::oid oid,match[2] fingerprint FROM regexp_matches(body,$pattern$\\(([0-9]+)::oid,'([a-f0-9]{64})'::text\\)$pattern$,'g') match LOOP
   IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=pin.oid AND encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')=pin.fingerprint)
   THEN RAISE EXCEPTION 'conversation_reader_leaf_changed';END IF;
   members:=array_append(members,pin.oid);
  END LOOP;
  IF cardinality(members)<>(CASE WHEN signature='application_native_worklist_helpers_current()' THEN 85 ELSE 4 END)
  THEN RAISE EXCEPTION 'conversation_reader_leaf_roster';END IF;
  INSERT INTO conversation_reader_contract_members SELECT unnest(members) ON CONFLICT DO NOTHING;
 END LOOP;
 INSERT INTO conversation_reader_contract_members VALUES('application_empty_query_helpers_current()'::regprocedure) ON CONFLICT DO NOTHING;
 INSERT INTO native_turn_contract_helpers(signature,fingerprint)
 SELECT p.oid::regprocedure::text,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p JOIN conversation_reader_contract_members m ON m.oid=p.oid
 ON CONFLICT DO NOTHING;
END $reader_contract_transfer$;
`

// Integrity-only promotion trigger reads protected provenance as its owner.
// The originating application transaction keeps all caller/source checks and
// row policies; neither raw metadata nor an owner capture is exposed.
const promotionSource=await readFile(new URL('../../migrations/8056_episodic_retained_promotion.sql',import.meta.url),'utf8')
if(hash(promotionSource)!=='091c667015667683999268dfb1d659c5c54fb81a524832ee5a2ba842e73f18f5')throw new Error('Promotion predecessor source changed')
const promotionBody=promotionSource.split('AS $$')[1]?.split('END $$;')[0]+'END '
if(!promotionBody.startsWith('\nBEGIN\n')||!promotionBody.includes('episodic_promotion_requires_derivation'))throw new Error('Promotion predecessor shape changed')
const promotionIntegrity=`DO $promotion_integrity$ DECLARE routine pg_proc;BEGIN
 SELECT * INTO STRICT routine FROM pg_proc WHERE oid='public.guard_episodic_promotion()'::regprocedure;
 IF routine.prosrc IS DISTINCT FROM ${literal(promotionBody)} OR routine.prosecdef
  OR routine.proowner<>(SELECT relowner FROM pg_class WHERE oid='episodic_memories'::regclass)
  OR routine.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
 THEN RAISE EXCEPTION 'conversation_promotion_predecessor_changed';END IF;
 ALTER FUNCTION public.guard_episodic_promotion() SECURITY DEFINER;
END $promotion_integrity$;
DO $episode_policy$ BEGIN
 IF (SELECT jsonb_agg(jsonb_build_object('polname',polname,'polcmd',polcmd,'polpermissive',polpermissive,'polroles',polroles::integer[],
  'using',pg_get_expr(polqual,polrelid),'check',pg_get_expr(polwithcheck,polrelid)) ORDER BY polname)
  FROM pg_policy WHERE polrelid='episodic_memories'::regclass AND polname IN('episodic_memories_own','episodic_revision_floor'))
  IS DISTINCT FROM ${literal("[{\"polname\":\"episodic_memories_own\",\"polcmd\":\"*\",\"polpermissive\":true,\"polroles\":[0],\"using\":\"(user_id = (current_setting('app.current_user_id'::text, true))::uuid)\",\"check\":null},{\"polname\":\"episodic_revision_floor\",\"polcmd\":\"r\",\"polpermissive\":false,\"polroles\":[0],\"using\":\"((scope_revision_id IS NOT NULL) AND session_context_revision_allowed(( SELECT sessions.workspace_id\\n   FROM sessions\\n  WHERE (sessions.id = episodic_memories.session_id)), scope_revision_id))\",\"check\":null}]")}::jsonb
 THEN RAISE EXCEPTION 'conversation_episode_policy_predecessor_changed';END IF;
END $episode_policy$;
-- Parent housekeeping consumes the same exact source authority as its reader.
-- A historical creator ID cannot substitute for, or veto, current admission.
DROP POLICY episodic_memories_own ON episodic_memories;
DROP POLICY episodic_revision_floor ON episodic_memories;
CREATE POLICY episodic_context_authority ON episodic_memories
 USING(scope_revision_id IS NOT NULL AND session_recording_read_allowed(session_id) AND EXISTS(
  SELECT 1 FROM sessions s WHERE s.id=episodic_memories.session_id
   AND session_context_revision_allowed(s.workspace_id,episodic_memories.scope_revision_id)))
 WITH CHECK(scope_revision_id IS NOT NULL AND session_recording_read_allowed(session_id) AND EXISTS(
  SELECT 1 FROM sessions s WHERE s.id=episodic_memories.session_id
   AND session_context_revision_allowed(s.workspace_id,episodic_memories.scope_revision_id)));
`

const predecessors=JSON.parse(await readFile(new URL('predecessors.json',directory),'utf8'))
const retiredImplementation=[
 'native_retained_graph_append(jsonb,jsonb,boolean)',
 'native_retained_graph_edges(jsonb,boolean)',
 'native_retained_graph_equal(jsonb,jsonb,boolean)',
 'native_retained_graph_seed(jsonb,boolean)',
 'native_retained_graph_topology(jsonb)',
 'native_retained_node_key(jsonb,boolean)', 
 'publish_native_session_message(uuid,uuid,jsonb,text,jsonb,jsonb)',
 "native_retained_cached_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb,jsonb,jsonb[])",
 "native_retained_cached_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb,jsonb,jsonb[])",
 "native_retained_cached_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb[])",
 "native_retained_cached_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb[])",
 "native_retained_capture_cohorts(uuid,jsonb,jsonb)",
 "native_retained_capture_plan(uuid,jsonb,jsonb)",
 "native_retained_capture_requirements(uuid,jsonb,jsonb)",
 "native_retained_edge_rows(uuid,jsonb[],integer[],boolean)",
 "native_retained_expand_frontier(uuid,jsonb,jsonb,boolean)",
 "native_retained_graph_closure(uuid,jsonb,boolean)",
 "native_retained_graph_overlay(jsonb,jsonb,boolean)",
 "native_retained_intern_frontier(uuid,jsonb[],integer[],boolean,integer)",
 "native_retained_metadata(uuid,jsonb,jsonb,boolean)",
 "native_retained_query_value(uuid,jsonb,text,jsonb,jsonb[])",
 "native_turn_capture_compact_requirements(uuid,jsonb,jsonb)",
 "native_turn_capture_parent(uuid,uuid)",
 "native_turn_capture_publication_cohorts(uuid,jsonb,jsonb)",
 "native_turn_capture_requirements(uuid,jsonb)",
 "native_turn_capture_requirements(uuid,jsonb,jsonb)",
 "native_turn_capture_sources(uuid,jsonb)",
 "native_turn_compact_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb)",
 "native_turn_compact_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb)",
 "native_turn_compact_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)",
 "native_turn_compact_metadata(uuid,jsonb,jsonb)",
 "native_turn_compact_point(uuid,text,uuid,text[],jsonb,jsonb,jsonb)",
 "native_turn_compact_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb)",
 "native_turn_compact_scope(uuid,text,uuid,text,jsonb,jsonb)",
 "native_turn_compact_topology(jsonb,jsonb)",
 "native_turn_completed_field(uuid,uuid,text,jsonb,jsonb)",
 "native_turn_completed_point(uuid,text,uuid,text[],jsonb,jsonb)",
 "native_turn_completed_scope(uuid,text,uuid,text,jsonb,jsonb)",
 "native_turn_discover_lock_requirements(uuid,jsonb,jsonb)",
 "native_turn_edges(uuid,jsonb)",
 "native_turn_empty_memory_context(uuid)",
 "native_turn_empty_memory_domain(uuid,uuid,text[],jsonb)",
 "native_turn_empty_memory_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)",
 "native_turn_lock_requirements(uuid,jsonb)",
 "native_turn_metadata_acquire(uuid,jsonb)",
 "native_turn_metadata_acquire(uuid,jsonb,jsonb)",
 "native_turn_parent(uuid,uuid,jsonb)",
 "native_turn_parent_scope(uuid,uuid)",
 "native_turn_principal_bounds(uuid,uuid,boolean)",
 "native_turn_query_bounds(uuid)",
 "native_turn_read_point(uuid,text,uuid,text[],jsonb,jsonb)",
 "native_turn_reduce_domain(uuid,text,uuid,text[],jsonb,jsonb)",
 "native_turn_reduce_envelope(uuid,text,uuid,text,text[],jsonb,jsonb)",
 "native_turn_reduce_field(uuid,uuid,text,jsonb,jsonb)",
 "native_turn_reduce_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)",
 "native_turn_session_bounds(uuid,jsonb)",
 "native_turn_topology(jsonb,jsonb)",
 "read_native_turn_compact_requirements(uuid,jsonb,jsonb)",
 "read_native_turn_query_requirements(uuid,jsonb,jsonb)"
]
const signatures=[
 'read_native_personal_title_group(uuid,uuid[],uuid[])',
 'native_personal_title_group_acquisition(uuid,uuid[],uuid[])',
 'session_context_file_revision_allowed(uuid,uuid)',
 'read_session_context_file_revision(uuid,uuid)',
 'read_native_file_session_title_revision(uuid,uuid,uuid)',
 'read_native_empty_query_evidence(uuid,text[],uuid[],text[])',
 'session_context_empty_query_revision_allowed(uuid,uuid)',
 'read_session_context_empty_query_revision(uuid,uuid)',
 'read_native_empty_query_session_title_revision(uuid,uuid,uuid)',

 'application_empty_query_facades_current()',
 'native_turn_helpers_current()',
 'validate_application_field_dependencies()',
 'read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)',
 'read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean)',
 'read_native_empty_query_session_evidence(uuid,text[],uuid[],text[],boolean)',
 'application_empty_query_helpers_current()',
 'enqueue_native_field_dependency_work()',
 'read_native_file_worklist_evidence(uuid,text[],uuid[],text[],boolean,boolean)',
 'validate_scope_resource_reference()',
 'read_native_covered_session_frame(uuid,text[],uuid[],text[])',
 'read_native_field_reference_snapshot(uuid,uuid,uuid,text)',
 'read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)',
 'read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)',
 'application_native_root_cover(uuid,jsonb)',
 'read_native_covered_memory_frame(uuid,text[],uuid[],text[],boolean)',
 'validate_native_covered_field_dependency_work(uuid,uuid,bigint)',
 'native_private_title_helpers_current()',
 'native_private_title_proof(uuid,uuid,uuid)',
 'application_native_context_fields_current()',
 'validate_native_field_dependency_batch(uuid,uuid,jsonb)',
 'application_memory_statement_helpers_current()',
 'application_native_dependency_batch_helpers_current()',
 'application_native_field_reference_helpers_current()',
 'application_native_covered_evidence_helpers_current()',
 'application_native_covered_queue_current()',

 'application_memory_statement_helpers_current()',
 'application_native_context_fields_current()',
 'application_native_covered_evidence_helpers_current()',
 'application_native_dependency_batch_helpers_current()',
 'application_native_field_reference_helpers_current()',
 'application_native_file_capture_helpers_current()',
 'application_native_title_acquisition_helpers_current()',
 'application_native_title_group_helpers_current()',
 'read_session_title_revision(uuid,uuid,uuid)',
 'application_native_worklist_helpers_current()',
 'capture_native_session_query_stage(uuid,uuid,integer,text,jsonb,jsonb)',
 'native_private_title_helpers_current()',
 'read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)',
 'read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)',
 'read_native_personal_title_group_evidence(uuid,uuid[],uuid[])',
 'read_native_private_title_acquisition(uuid,uuid,uuid)',
 'read_native_private_title_evidence(uuid,uuid)',
 'validate_application_field_dependencies()',
 'application_native_member_field_permissions(uuid,jsonb,uuid)',
 'application_memory_statement_helpers_current()',
 'application_native_worklist_helpers_current()',
 'application_empty_query_helpers_current()',
 'application_native_covered_evidence_helpers_current()',
 ...retiredImplementation,
 'read_native_covered_session_evidence(uuid,text[],uuid[],text[])',
 'read_native_session_field_snapshots(uuid,uuid[],text[])',
 'session_context_revision_allowed(uuid,uuid)',
 'application_native_title_group_helpers_current()',
 'application_native_title_acquisition_helpers_current()',
 'read_native_personal_title_group_evidence(uuid,uuid[],uuid[])',
 'read_native_session_field_dependencies(uuid,text[],uuid[],text[])',
 'native_turn_capture_compact_requirements(uuid,jsonb,jsonb)',
 'native_retained_helpers_current()','native_turn_helpers_current()',
 'read_native_retained_requirements(uuid,jsonb,jsonb)',
 'native_retained_capture_cohorts(uuid,jsonb,jsonb)','native_retained_capture_requirements(uuid,jsonb,jsonb)',
 'read_native_turn_requirements(uuid,jsonb)',
 'read_native_retained_scope_evidence(uuid,jsonb)','read_native_retained_publication_cohorts(uuid,jsonb)',
 'native_turn_frame_payload_shape(jsonb)','native_turn_frame_pair(uuid,uuid)',
 'publish_native_turn_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)',
 'native_turn_guard_completion_debt()','native_turn_validate_event(jsonb)','native_turn_capture_event(jsonb)',
 'validate_application_field_dependencies()','prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)',
 'publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)',
 'application_native_field_reference_helpers_current()','native_turn_field_reference(uuid,uuid,uuid,text)',
 'native_turn_complete_publication()',
 'native_turn_publication_contract()','native_turn_prepare_publication(uuid,uuid,text,jsonb,jsonb)',
 'enqueue_native_field_dependency_work()','publish_native_turn_annotation(uuid,uuid,uuid,uuid,jsonb,text,jsonb,uuid,bigint)',
 'application_native_dependency_batch_helpers_current()','validate_scope_resource_reference()',
 'native_turn_page_event(jsonb)','validate_page_derivation_dependencies()',
 'publish_native_session_context_revision(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer)',
].filter((signature,index,all)=>all.indexOf(signature)===index).sort()
const files=['field-permissions.sql','retire-action-snapshots.sql','authority.sql','field-reference.sql','retire-field-queue.sql','field-dependencies.sql','edges.sql','requirements.sql','manifest.sql','frame.sql','messages.sql','completion.sql','context.sql','recording.sql','privacy.sql','native-snapshots.sql','graph.sql','capture.sql','evidence.sql','title-evidence.sql','revision-access.sql','field-snapshots.sql']
const sources=(await Promise.all(files.map(file=>readFile(new URL(file,directory),'utf8')))).join('\n')
const ruleContracts=JSON.parse(await readFile(new URL('rule-contract-predecessors.json',directory),'utf8'))
const captureDependencies=JSON.parse(await readFile(new URL('capture-dependencies.json',directory),'utf8'))
const retiredReaders=[
 'native_private_title_frame(uuid,jsonb)',
 'native_private_title_proof(uuid,uuid,uuid)',
 'native_private_title_helpers_current()',
 'read_native_private_title_evidence(uuid,uuid)',
 'read_native_private_title_acquisition(uuid,uuid,uuid)',
 'read_native_file_session_title_revision(uuid,uuid,uuid)',
 'read_native_empty_query_session_title_revision(uuid,uuid,uuid)',
 'read_session_context_file_revision(uuid,uuid)',
 'read_session_context_empty_query_revision(uuid,uuid)',
 'session_context_file_revision_allowed(uuid,uuid)',
 'session_context_empty_query_revision_allowed(uuid,uuid)',
 'application_empty_query_facades_current()',

 'enqueue_native_field_dependency_work()',
 'validate_native_field_dependency_batch(uuid,uuid,jsonb)',
 'validate_native_covered_field_dependency_work(uuid,uuid,bigint)',
 'read_native_field_reference_snapshot(uuid,uuid,uuid,text)',
 'application_memory_statement_helpers_current()',
 'application_native_dependency_batch_helpers_current()',
 'application_native_field_reference_helpers_current()',
 'application_native_covered_evidence_helpers_current()',
 'application_native_covered_queue_current()',

 'publish_native_turn_annotation(uuid,uuid,uuid,uuid,jsonb,text,jsonb,uuid,bigint)',
 'native_turn_prepare_publication(uuid,uuid,text,jsonb,jsonb)',
 'publish_native_turn_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)',
 'application_native_transcript_prepare_helpers_current()',
 'prepare_native_session_message_covered(uuid,uuid,text,jsonb,jsonb)',
 ...retiredImplementation,
 'prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)',
 'read_native_covered_session_evidence(uuid,text[],uuid[],text[])',
 'read_native_turn_requirements(uuid,jsonb)',
 'read_native_retained_requirements(uuid,jsonb,jsonb)',
 'read_native_turn_session_query(uuid,uuid,integer,integer)',
 'read_native_turn_scope_evidence(uuid,jsonb)',
 'read_native_turn_publication_cohorts(uuid,jsonb)',
 'read_native_retained_scope_evidence(uuid,jsonb)',
 'read_native_retained_publication_cohorts(uuid,jsonb)',
 'read_native_retained_session_query(uuid,uuid,integer,integer)',
 'read_native_session_query_evidence(uuid,uuid,integer,integer)',
 'application_native_session_query_acquisition_current()',
 'read_native_application_session_history(uuid,uuid,integer)',
 'read_native_application_session_topics(uuid,uuid,integer)',
 'read_native_application_session_projection(uuid,uuid,integer,text)',
]
const migration=`-- [COMP:api/native-turn-frame] One publication algorithm, format-1 read compatibility.
-- Generated from scripts/conversation-store; no applied migration is modified.
BEGIN;
${authenticate}
${flatAuthentication}
DO $authenticate_consumers$
DECLARE expected jsonb;actual pg_proc;pin text;owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);
BEGIN
 -- Authenticate legacy writers and the field-dependency adapter outside the
 -- native registry using their complete portable bodies, metadata and grants.
 FOR expected IN SELECT value FROM jsonb_array_elements(${literal(JSON.stringify(predecessors))}::jsonb) LOOP
  SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure('public.'||(expected->>'signature'));
  SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO pin FROM pg_proc p WHERE p.oid=to_regprocedure('public.'||(expected->>'pin'));
  IF actual.oid IS NULL OR pin IS NULL
   OR (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','pronamespace','prolang','proacl']) IS DISTINCT FROM expected->'metadata'
   OR actual.proowner<>owner_id OR actual.pronamespace<>'public'::regnamespace
   OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
   OR (length(actual.prosrc)-length(replace(actual.prosrc,pin,'')))/64<>(expected->>'occurrences')::integer
   OR encode(sha256(convert_to(replace(actual.prosrc,pin,'__PIN__'),'UTF8')),'hex') IS DISTINCT FROM expected->>'body'
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
    WHERE a.grantor<>owner_id OR a.privilege_type<>'EXECUTE' OR a.is_grantable
     OR a.grantee<>owner_id AND NOT((expected->>'appExecute')::boolean AND a.grantee=(SELECT oid FROM pg_roles WHERE rolname='app_user')))
  THEN RAISE EXCEPTION 'conversation_predecessor_changed: %',expected->>'signature';END IF;
 END LOOP;
END $authenticate_consumers$;
-- A pin in an authenticated body authenticates the complete dependent pg_proc
-- row. Walk only exact fingerprints; never execute catalog code to enroll it.
CREATE TEMP TABLE conversation_authenticated ON COMMIT DROP AS
 WITH RECURSIVE catalog AS MATERIALIZED(
  SELECT p.oid,p.prosrc,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') fingerprint
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind='f'
 ), trusted(oid) AS(
  SELECT to_regprocedure('public.'||signature)::oid FROM native_turn_contract_helpers
  UNION SELECT to_regprocedure('public.'||(value->>'signature'))::oid FROM jsonb_array_elements(${literal(JSON.stringify(predecessors))}::jsonb)
  UNION SELECT p.oid FROM trusted t JOIN catalog caller ON caller.oid=t.oid
   JOIN catalog p ON p.oid=ANY(ARRAY(SELECT to_regprocedure('public.'||s)::oid FROM unnest(${array(signatures)}) s))
    AND strpos(caller.prosrc,quote_literal(p.fingerprint))>0
 ) SELECT DISTINCT oid FROM trusted;
INSERT INTO conversation_authenticated SELECT to_regprocedure('public.'||(value->>'signature'))::oid
 FROM jsonb_array_elements(${literal(JSON.stringify(predecessors))}::jsonb);
INSERT INTO conversation_authenticated VALUES('application_native_dependency_batch_helpers_current()'::regprocedure),('application_native_field_reference_helpers_current()'::regprocedure);
DO $retained_authentication$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM conversation_authenticated WHERE oid='native_retained_helpers_current()'::regprocedure)
 THEN RAISE EXCEPTION 'conversation_retained_guard_untrusted';END IF;
 IF native_retained_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'conversation_retained_contract_changed';END IF;
END $retained_authentication$;
INSERT INTO conversation_authenticated SELECT to_regprocedure('public.'||signature)::oid FROM native_retained_contract_helpers;
${readerContractTransfer}
INSERT INTO conversation_authenticated SELECT oid FROM conversation_reader_contract_members;
-- Authenticate the additional old comparator dependencies before propagating
-- the reviewed policy-owner body. No unknown executable is enrolled by calling it.
DO $rule_contract_predecessors$ DECLARE expected jsonb;actual pg_proc;normalized text;pin record;seen text[];body_dependency text;body_pin text;legacy_app_default boolean;owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='sessions'::regclass);BEGIN
 SELECT EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  WHERE d.defaclrole=owner_id AND d.defaclnamespace IN(0,'public'::regnamespace) AND d.defaclobjtype='f'
   AND a.grantor=owner_id AND a.grantee=(SELECT oid FROM pg_roles WHERE rolname='app_user')
   AND a.privilege_type='EXECUTE' AND NOT a.is_grantable) INTO legacy_app_default;
 FOR expected IN SELECT value FROM jsonb_array_elements(${literal(JSON.stringify(ruleContracts))}::jsonb) LOOP
  SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure('public.'||(expected->>'signature'));
  normalized:=actual.prosrc;seen:='{}';
  IF jsonb_array_length(expected->'pins')>0 THEN
   FOR pin IN SELECT match[1]::oid oid,match[2] fingerprint FROM regexp_matches(normalized,$pattern$\\(([0-9]+)::oid,'([a-f0-9]{64})'::text\\)$pattern$,'g') match LOOP
    IF NOT EXISTS(SELECT 1 FROM conversation_authenticated a JOIN pg_proc p ON p.oid=a.oid WHERE p.oid=pin.oid
     AND encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')=pin.fingerprint)
    THEN RAISE EXCEPTION 'conversation_rule_leaf_untrusted: %',pin.oid::regprocedure;END IF;
    seen:=array_append(seen,pin.oid::regprocedure::text);
   END LOOP;
   normalized:=regexp_replace(normalized,$pattern$\\(([0-9]+)::oid,'([a-f0-9]{64})'::text\\)$pattern$,'__PIN__','g');
  END IF;
  -- Raw-body pins vary with already-authenticated dependency catalogs.
  -- Normalize only reviewed identities; their actual bodies remain checked.
  FOR body_dependency IN SELECT jsonb_array_elements_text(coalesce(expected->'bodyPins','[]')) LOOP
   SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') INTO body_pin FROM pg_proc p
    WHERE p.oid=to_regprocedure('public.'||body_dependency);
   IF body_pin IS NULL OR strpos(normalized,quote_literal(body_pin))=0
    OR NOT EXISTS(SELECT 1 FROM conversation_authenticated WHERE oid=to_regprocedure('public.'||body_dependency))
     AND body_pin IS DISTINCT FROM expected#>>ARRAY['bodyPinHashes',body_dependency]
   THEN RAISE EXCEPTION 'conversation_rule_body_dependency_changed: %',body_dependency;END IF;
   normalized:=replace(normalized,quote_literal(body_pin),quote_literal('__BODY_PIN:'||body_dependency||'__'));
  END LOOP;
  IF actual.oid IS NULL OR actual.proowner<>owner_id OR actual.pronamespace<>'public'::regnamespace
   OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname=expected->>'language')
   OR (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','pronamespace','prolang','proacl','proargtypes']) IS DISTINCT FROM expected->'metadata'
   OR encode(sha256(convert_to(normalized,'UTF8')),'hex') IS DISTINCT FROM expected->>'body'
   OR to_jsonb(seen) IS DISTINCT FROM expected->'pins'
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
    WHERE a.grantor<>owner_id OR a.privilege_type<>'EXECUTE' OR a.is_grantable
     OR a.grantee<>owner_id AND NOT(((expected->>'appExecute')::boolean OR legacy_app_default) AND a.grantee=(SELECT oid FROM pg_roles WHERE rolname='app_user')))
  THEN RAISE EXCEPTION 'conversation_rule_predecessor_changed: %',expected->>'signature';END IF;
  INSERT INTO conversation_authenticated VALUES(actual.oid);
 END LOOP;
END $rule_contract_predecessors$;

-- Preserve the authenticated comparator executable and its exact leaf roster.
-- Rebuild only typed catalog-row literals; nested bodies cannot be repaired by
-- global fingerprint substitution without changing another comparator's data.
CREATE TEMP TABLE conversation_contract_predicates(predicate text NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE conversation_flat_contracts(oid oid PRIMARY KEY,prefix text,suffix text,members oid[]) ON COMMIT DROP;
DO $flat_contracts$ DECLARE signature text;body text;begin_at integer;end_at integer;join_at integer;members oid[];ok boolean;tail text;condition text;ending constant text:=' THEN RETURN false;END IF;';BEGIN
 FOREACH signature IN ARRAY ARRAY['application_memory_statement_helpers_current()',
  'application_native_dependency_batch_helpers_current()','application_native_field_reference_helpers_current()',
  'application_native_covered_evidence_helpers_current()'] LOOP
  IF NOT EXISTS(SELECT 1 FROM conversation_authenticated WHERE oid=to_regprocedure(signature))
  THEN RAISE EXCEPTION 'conversation_flat_contract_untrusted: %',signature;END IF;
  EXECUTE 'SELECT public.'||signature INTO ok;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'conversation_flat_contract_changed: %',signature;END IF;
  SELECT prosrc INTO STRICT body FROM pg_proc WHERE oid=to_regprocedure(signature);
  begin_at:=strpos(body,'FROM (VALUES ')+length('FROM (VALUES ');
  end_at:=length(body)-strpos(reverse(body),reverse(') m(oid,'))-length(') m(oid,')+2;
  join_at:=length(body)-strpos(reverse(body),reverse(' JOIN pg_catalog.pg_proc p ON p.oid=m.oid'))-length(' JOIN pg_catalog.pg_proc p ON p.oid=m.oid')+2;
  IF begin_at<=length('FROM (VALUES ') OR end_at<begin_at OR join_at<end_at
  THEN RAISE EXCEPTION 'conversation_flat_contract_shape: %',signature;END IF;
  EXECUTE 'SELECT array_agg(m.oid ORDER BY m.oid) FROM (VALUES '||substring(body FROM begin_at FOR join_at-begin_at) INTO members;
  IF members IS NULL OR cardinality(members)<>cardinality(ARRAY(SELECT DISTINCT unnest(members)))
  THEN RAISE EXCEPTION 'conversation_flat_contract_roster: %',signature;END IF;
  INSERT INTO conversation_flat_contracts VALUES(to_regprocedure(signature),left(body,begin_at-1),substring(body FROM end_at),members);
  INSERT INTO conversation_authenticated SELECT unnest(members);
  INSERT INTO native_turn_contract_helpers(signature,fingerprint)
   SELECT p.oid::regprocedure::text,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=ANY(members) ON CONFLICT DO NOTHING;
  -- Transfer non-function predicates verbatim from the authenticated comparator.
  tail:=substring(body FROM join_at+length(' JOIN pg_catalog.pg_proc p ON p.oid=m.oid)'));
  IF signature IN('application_native_dependency_batch_helpers_current()','application_native_field_reference_helpers_current()') THEN
   IF left(tail,length(' IS NOT TRUE THEN RETURN false;END IF;'))<>' IS NOT TRUE THEN RETURN false;END IF;'
   THEN RAISE EXCEPTION 'conversation_table_contract_shape';END IF;
   tail:=substring(tail FROM length(' IS NOT TRUE THEN RETURN false;END IF;')+1);
   WHILE left(ltrim(tail,E' \n'),3)='IF ' LOOP
    tail:=substring(ltrim(tail,E' \n') FROM 4);
    IF strpos(tail,ending)=0 THEN RAISE EXCEPTION 'conversation_table_contract_shape';END IF;
    condition:=left(tail,strpos(tail,ending)-1);
    INSERT INTO conversation_contract_predicates VALUES('NOT('||condition||')');
    tail:=substring(tail FROM strpos(tail,ending)+length(ending));
   END LOOP;
   IF btrim(tail,E' \n')<>'RETURN true;END' THEN RAISE EXCEPTION 'conversation_table_contract_tail';END IF;
  ELSIF tail<>';END' THEN RAISE EXCEPTION 'conversation_table_contract_tail';END IF;
 END LOOP;
END $flat_contracts$;
CREATE TEMP TABLE conversation_before ON COMMIT DROP AS
 SELECT p.oid,p.oid::regprocedure::text signature,to_jsonb(p) metadata,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') fingerprint
 FROM pg_proc p WHERE p.oid=ANY(ARRAY(SELECT to_regprocedure('public.'||s)::oid FROM unnest(${array(signatures)}) s));
DO $roster$ BEGIN
 IF (SELECT count(*) FROM conversation_before)<>${signatures.length}
  OR EXISTS(SELECT 1 FROM conversation_before b WHERE NOT EXISTS(SELECT 1 FROM conversation_authenticated a WHERE a.oid=b.oid))
 THEN RAISE EXCEPTION 'conversation_untrusted_consumer' USING DETAIL=(SELECT string_agg(b.signature,',') FROM conversation_before b WHERE NOT EXISTS(SELECT 1 FROM conversation_authenticated a WHERE a.oid=b.oid));END IF;
END $roster$;
-- Only exact known private functions with an authenticated legacy default ACL
-- reach here. Capture their old rows first so all callers are repinned below.
DO $private_rule_acl$ DECLARE expected jsonb;BEGIN
 FOR expected IN SELECT value FROM jsonb_array_elements(${literal(JSON.stringify(ruleContracts))}::jsonb) WHERE (value->>'appExecute')::boolean IS FALSE LOOP
  IF EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   WHERE p.oid=to_regprocedure('public.'||(expected->>'signature')) AND a.grantee=(SELECT oid FROM pg_roles WHERE rolname='app_user'))
  THEN EXECUTE 'REVOKE ALL ON FUNCTION public.'||(expected->>'signature')||' FROM app_user';END IF;
 END LOOP;
END $private_rule_acl$;



CREATE TEMP TABLE conversation_constraint_before ON COMMIT DROP AS
 SELECT to_jsonb(c) metadata FROM pg_constraint c WHERE conrelid='native_turn_frames'::regclass AND conname='native_turn_frames_format_check';
ALTER TABLE native_turn_publication_work ADD COLUMN completion_owner uuid;
ALTER TABLE native_turn_frames DROP CONSTRAINT native_turn_frames_format_check;
ALTER TABLE native_turn_frames ADD CONSTRAINT native_turn_frames_format_check CHECK(format IN(1,2));
DO $replace$ DECLARE pin text;BEGIN
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO STRICT pin FROM pg_proc p WHERE p.oid='application_native_context_fields_current()'::regprocedure;
 EXECUTE replace($sources$${sources}$sources$,'__CONTEXT_GUARD_FINGERPRINT__',pin);
END $replace$;
-- A known new trigger adapter is enrolled from the reviewed source above.
INSERT INTO conversation_before
 SELECT p.oid,p.oid::regprocedure::text,to_jsonb(p),encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
 FROM pg_proc p WHERE p.oid='native_turn_capture_event()'::regprocedure;
INSERT INTO native_turn_contract_helpers(signature,fingerprint)
 SELECT p.oid::regprocedure::text,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE p.oid='native_turn_capture_event()'::regprocedure;
-- The retired queue's two table contracts disappear with its tables. Preserve
-- the source FK contract; replace only the authenticated trigger roster after
-- the single reviewed trigger substitution under the relation's DDL lock.
DELETE FROM conversation_contract_predicates WHERE strpos(predicate,'native_field_dependency_batches')>0;
INSERT INTO conversation_contract_predicates
 SELECT '(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_catalog.pg_trigger t WHERE t.tgrelid=''public.scope_derivation_sources''::regclass) IS NOT DISTINCT FROM '
  ||quote_literal(jsonb_agg(to_jsonb(t) ORDER BY t.oid)::text)||'::jsonb'
 FROM pg_trigger t WHERE t.tgrelid='public.scope_derivation_sources'::regclass;

DO $event_completion_owner$ DECLARE signature text;definition text;old_lookup constant text:='frame_id=selected_frame;';BEGIN
 FOREACH signature IN ARRAY ARRAY['native_turn_validate_event(jsonb)','native_turn_page_event(jsonb)'] LOOP
  definition:=pg_get_functiondef(to_regprocedure(signature));
  IF strpos(definition,'SELECT * INTO seal FROM native_turn_publication_seals WHERE transaction_id=txid_current() AND frame_id=selected_frame;')=0
  THEN RAISE EXCEPTION 'conversation_event_predecessor_changed';END IF;
  definition:=replace(definition,'SELECT * INTO seal FROM native_turn_publication_seals WHERE transaction_id=txid_current() AND frame_id=selected_frame;',
   'SELECT * INTO seal FROM native_turn_publication_seals WHERE transaction_id=txid_current() AND frame_id=coalesce(work.completion_owner,selected_frame);');
  definition:=replace(definition,'WHERE n->>''derivationId''=output.id::text','WHERE (work.completion_owner IS NULL OR n->>''frameId''=selected_frame::text) AND n->>''derivationId''=output.id::text');
  EXECUTE definition;
 END LOOP;
END $event_completion_owner$;
DO $title_event_owner$ DECLARE definition text;signature text;BEGIN
 definition:=pg_get_functiondef('native_turn_event_frame(uuid,uuid)'::regprocedure);
 IF strpos(definition,'r.parent_kind=''message_annotation''')=0 THEN RAISE EXCEPTION 'conversation_title_event_predecessor_changed';END IF;
 EXECUTE replace(definition,'r.parent_kind=''message_annotation''','r.parent_kind IN(''message_annotation'',''session_title'')');
 FOREACH signature IN ARRAY ARRAY['native_turn_validate_event(jsonb)','native_turn_page_event(jsonb)'] LOOP
 definition:=pg_get_functiondef(signature::regprocedure);
 IF strpos(definition,'n->>''kind''=''message_annotation''')=0 THEN RAISE EXCEPTION 'conversation_title_validator_predecessor_changed';END IF;
 EXECUTE replace(definition,'n->>''kind''=''message_annotation''','n->>''kind'' IN(''message_annotation'',''session_title'')');
 END LOOP;
END $title_event_owner$;

-- Retired title comparators contribute their authenticated leaf records to the
-- existing registry, never a parallel title registry or runtime availability route.
INSERT INTO native_turn_contract_helpers(signature,fingerprint)
 SELECT p.oid::regprocedure::text,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
 FROM pg_proc p JOIN conversation_authenticated a ON a.oid=p.oid
 WHERE p.oid IN(SELECT to_regprocedure('public.'||member)::oid
  FROM jsonb_array_elements(${literal(JSON.stringify(ruleContracts))}::jsonb) descriptor
  CROSS JOIN LATERAL jsonb_array_elements_text(descriptor->'pins') member
  WHERE descriptor->>'signature' IN('native_private_title_helpers_current()','application_empty_query_facades_current()'))
 ON CONFLICT DO NOTHING;
DO $canonical_contract_consumers$ DECLARE dependency record;caller record;definition text;canonical oid:='native_turn_helpers_current()'::regprocedure;
BEGIN
 IF (SELECT count(*) FROM conversation_contract_predicates)<>2 THEN RAISE EXCEPTION 'conversation_table_contract_roster';END IF;
 FOR dependency IN SELECT b.*,p.proname FROM conversation_before b JOIN pg_proc p ON p.oid=b.oid
  WHERE b.signature=ANY(ARRAY['application_memory_statement_helpers_current()','application_native_dependency_batch_helpers_current()',
   'application_native_field_reference_helpers_current()','application_native_covered_evidence_helpers_current()','application_native_covered_queue_current()',
   'native_private_title_helpers_current()','application_empty_query_facades_current()']) LOOP
  FOR caller IN SELECT p.oid,p.prosrc FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind='f'
   AND NOT(p.oid::regprocedure::text=ANY(${array(retiredReaders)})) AND p.oid<>canonical AND p.oid<>'native_retained_helpers_current()'::regprocedure
   AND(p.prosrc~('(^|[^[:alnum:]_])'||dependency.proname||'([^[:alnum:]_]|$)') OR strpos(p.prosrc,dependency.fingerprint)>0) LOOP
   IF NOT EXISTS(SELECT 1 FROM conversation_before b WHERE b.oid=caller.oid)
   THEN RAISE EXCEPTION 'conversation_unreviewed_contract_consumer: %',caller.oid::regprocedure;END IF;
   definition:=pg_get_functiondef(caller.oid);
   definition:=replace(definition,dependency.proname,'native_turn_helpers_current');
   definition:=replace(definition,dependency.fingerprint,'__CANONICAL_GUARD_FINGERPRINT__');
   definition:=replace(definition,dependency.oid::text||'::oid',canonical::text||'::oid');
   EXECUTE definition;
  END LOOP;
 END LOOP;
END $canonical_contract_consumers$;
DO $capture_dependencies$ DECLARE expected jsonb;actual pg_proc;owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='sessions'::regclass);BEGIN
 FOR expected IN SELECT value FROM jsonb_array_elements(${literal(JSON.stringify(captureDependencies))}::jsonb) LOOP
  SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure('public.'||(expected->>'signature'));
  IF actual.oid IS NULL OR actual.proowner<>owner_id OR actual.pronamespace<>'public'::regnamespace
   OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname=expected->>'language')
   OR (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','pronamespace','prolang','proacl']) IS DISTINCT FROM expected->'metadata'
   OR encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex') IS DISTINCT FROM expected->>'body'
   OR strpos((SELECT prosrc FROM pg_proc WHERE oid='native_turn_compact_metadata(uuid,jsonb,jsonb)'::regprocedure),quote_literal(expected->>'body'))=0
   OR (SELECT count(*)<>CASE WHEN (expected->>'appExecute')::boolean THEN 2 ELSE 1 END OR bool_or(a.grantor<>owner_id OR a.privilege_type<>'EXECUTE' OR a.is_grantable
     OR a.grantee<>owner_id AND (NOT (expected->>'appExecute')::boolean OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='app_user')))
    FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a)
  THEN RAISE EXCEPTION 'conversation_capture_dependency_changed: %',expected->>'signature';END IF;
  INSERT INTO native_turn_contract_helpers(signature,fingerprint) VALUES(expected->>'signature',encode(sha256(convert_to(to_jsonb(actual)::text,'UTF8')),'hex')) ON CONFLICT DO NOTHING;
 END LOOP;
END $capture_dependencies$;
${mediaRegistry}
-- The successor is installed from this template, never adopted from catalog code.
INSERT INTO native_turn_contract_helpers(signature,fingerprint)
 SELECT p.oid::regprocedure::text,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
 FROM pg_proc p WHERE oid=ANY(ARRAY['read_native_session_field_snapshots(uuid,uuid[],text[])'::regprocedure::oid,
  'capture_conversation_query(uuid,uuid,integer,integer)'::regprocedure::oid,
  'capture_conversation_selection(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb)'::regprocedure::oid,
  'conversation_prepare_publications(uuid,uuid,jsonb)'::regprocedure::oid,
  'conversation_source_edges(uuid,text,uuid,text)'::regprocedure::oid,
  'conversation_capture_privacy(uuid,jsonb)'::regprocedure::oid,
  'conversation_recording_scope(uuid,jsonb)'::regprocedure::oid,
  'conversation_message_snapshot(uuid,uuid,jsonb)'::regprocedure::oid,
  'conversation_revision_snapshot(uuid,uuid,jsonb)'::regprocedure::oid,
  'conversation_dag(uuid,jsonb,jsonb)'::regprocedure::oid,
  'conversation_dag_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb[])'::regprocedure::oid,
  'conversation_dag_edges(uuid,jsonb)'::regprocedure::oid,
  'conversation_dag_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb[])'::regprocedure::oid,
  'conversation_dag_point(uuid,text,uuid,text[],jsonb,jsonb,jsonb[])'::regprocedure::oid,
  'conversation_dag_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb[])'::regprocedure::oid,
  'conversation_dag_scope(uuid,text,uuid,text,jsonb,jsonb,jsonb[])'::regprocedure::oid,
  'capture_conversation_evidence(uuid,jsonb,jsonb,jsonb)'::regprocedure::oid,
  'read_session_authority_facts(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean)'::regprocedure::oid,
  'read_session_department_facts(uuid,uuid,uuid)'::regprocedure::oid]);
DO $query_rosters$ DECLARE signature text;definition text;old_array text;new_array text;start_at integer;end_at integer;
BEGIN
 FOREACH signature IN ARRAY ARRAY['native_turn_helpers_current()','native_retained_helpers_current()'] LOOP
  definition:=pg_get_functiondef(to_regprocedure(signature));
  start_at:=strpos(definition,'array_agg(h.signature ORDER BY h.signature)=')+length('array_agg(h.signature ORDER BY h.signature)=');
  end_at:=strpos(substring(definition FROM start_at),'::text[]')+start_at-1;
  IF start_at<=length('array_agg(h.signature ORDER BY h.signature)=') OR end_at<start_at THEN RAISE EXCEPTION 'conversation_reader_roster_shape';END IF;
  old_array:=substring(definition FROM start_at FOR end_at-start_at);
  IF signature='native_turn_helpers_current()' THEN
   DELETE FROM native_turn_contract_helpers h WHERE h.signature=ANY(${array(retiredReaders)});
   SELECT 'ARRAY['||string_agg(quote_literal(h.signature),',' ORDER BY h.signature)||']' INTO new_array FROM native_turn_contract_helpers h;
  ELSE
   DELETE FROM native_retained_contract_helpers h WHERE h.signature=ANY(${array(retiredReaders)});
   SELECT 'ARRAY['||string_agg(quote_literal(h.signature),',' ORDER BY h.signature)||']' INTO new_array FROM native_retained_contract_helpers h;
  END IF;
  EXECUTE replace(definition,old_array,new_array);
 END LOOP;
END $query_rosters$;
-- Replace repeated catalog serialization/hashing with complete native record
-- comparison. Keep the predecessor hashes only until reviewed pin propagation
-- finishes, then remove that column before validating the installed successor.
ALTER TABLE native_turn_contract_helpers ADD COLUMN contract pg_catalog.pg_proc;
DO $contract_records$ DECLARE definition text;catalog_shape jsonb;old_clause text:='h.fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')';old_join text:='p.oid=to_regprocedure(h.signature)';BEGIN
 definition:=pg_get_functiondef('native_turn_helpers_current()'::regprocedure);
 IF strpos(definition,old_clause)=0 OR strpos(definition,old_join)=0 OR strpos(definition,'ARRAY[''signature'',''fingerprint'']')=0 THEN RAISE EXCEPTION 'conversation_contract_predecessor_changed';END IF;
 SELECT jsonb_agg(jsonb_build_array(attnum,attname,atttypid,atttypmod,attcollation) ORDER BY attnum) INTO catalog_shape
 FROM pg_attribute WHERE attrelid='pg_catalog.pg_proc'::regclass AND attnum>0 AND NOT attisdropped;
 definition:=replace(definition,'SELECT EXISTS(SELECT 1 FROM pg_class relation',
  'SELECT (SELECT jsonb_agg(jsonb_build_array(attnum,attname,atttypid,atttypmod,attcollation) ORDER BY attnum) FROM pg_catalog.pg_attribute WHERE attrelid=''pg_catalog.pg_proc''::regclass AND attnum>0 AND NOT attisdropped) IS NOT DISTINCT FROM '||quote_literal(catalog_shape::text)||'::jsonb AND EXISTS(SELECT 1 FROM pg_class relation');
 EXECUTE replace(replace(replace(definition,old_join,'p.oid=(h.contract).oid'),old_clause,'p IS NOT DISTINCT FROM h.contract'),'ARRAY[''signature'',''fingerprint'']','ARRAY[''signature'',''contract'']');
END $contract_records$;
DO $canonical_contract_tables$ DECLARE definition text;predicates text;BEGIN
 -- Only the surviving source FK and trigger contracts remain. The former
 -- queue state and its repeated predicates have no runtime owner.
 IF (SELECT count(DISTINCT predicate) FROM conversation_contract_predicates)<>2
 THEN RAISE EXCEPTION 'conversation_distinct_table_contract_roster';END IF;
 SELECT string_agg('('||predicate||')',' AND ' ORDER BY predicate) INTO predicates
 FROM (SELECT DISTINCT predicate FROM conversation_contract_predicates) contracts;
 definition:=pg_get_functiondef('native_turn_helpers_current()'::regprocedure);
 IF strpos(definition,'SELECT native_turn_publication_contract() AND ')=0 THEN RAISE EXCEPTION 'conversation_contract_owner_shape';END IF;
 EXECUTE replace(definition,'SELECT native_turn_publication_contract() AND ','SELECT native_turn_publication_contract() AND ('||predicates||') AND ');
END $canonical_contract_tables$;
DO $canonical_contract_pins$ DECLARE pin text;caller record;BEGIN
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO STRICT pin FROM pg_proc p WHERE p.oid='native_turn_helpers_current()'::regprocedure;
 FOR caller IN SELECT p.oid,pg_get_functiondef(p.oid) definition FROM pg_proc p
  JOIN conversation_before b ON b.oid=p.oid WHERE strpos(p.prosrc,'__CANONICAL_GUARD_FINGERPRINT__')>0 LOOP
  EXECUTE replace(caller.definition,'__CANONICAL_GUARD_FINGERPRINT__',pin);
 END LOOP;
END $canonical_contract_pins$;
DO $capture_guard$ DECLARE definition text;pin text;signature text;BEGIN
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO STRICT pin FROM pg_proc p WHERE p.oid='native_turn_helpers_current()'::regprocedure;
 FOREACH signature IN ARRAY ARRAY['capture_conversation_query(uuid,uuid,integer,integer)','capture_conversation_evidence(uuid,jsonb,jsonb,jsonb)','read_native_session_field_dependencies(uuid,text[],uuid[],text[])','publish_native_session_context_revision(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer)'] LOOP
 definition:=pg_get_functiondef(to_regprocedure(signature));
 EXECUTE replace(definition,'__CAPTURE_GUARD_FINGERPRINT__',pin);END LOOP;
 UPDATE native_turn_contract_helpers h SET fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p
 WHERE h.signature IN('capture_conversation_query(uuid,uuid,integer,integer)','capture_conversation_evidence(uuid,jsonb,jsonb,jsonb)','read_native_session_field_dependencies(uuid,text[],uuid[],text[])','publish_native_session_context_revision(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer)') AND p.oid=to_regprocedure(h.signature);
END $capture_guard$;

DO $capture$ DECLARE definition text;old_clause text:=' OR EXISTS(SELECT 1 FROM native_turn_publication_seals seal WHERE seal.transaction_id=txid_current() AND seal.frame_id=selected_frame)';
BEGIN
 definition:=pg_get_functiondef('native_turn_capture_event(jsonb)'::regprocedure);
 IF (length(definition)-length(replace(definition,old_clause,'')))/length(old_clause)<>1 THEN RAISE EXCEPTION 'conversation_capture_predecessor_changed';END IF;
 -- All rows of one compound write are visible to its AFTER triggers. The
 -- existing completion debt still requires every exact event to be discharged.
 EXECUTE replace(definition,old_clause,'');
END $capture$;
-- Executable/table contracts belong to the physical writer and independent
-- completion, not each event. These are authenticated private callees; their
-- original context, source, seal, debt and exact event predicates remain.
DO $publication_contract_owner$ DECLARE signature text;definition text;pin text;predicate text;old_fragment text;new_fragment text;BEGIN
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO STRICT pin FROM pg_proc p WHERE p.oid='native_turn_publication_contract()'::regprocedure;
 predicate:='(SELECT encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'') FROM pg_proc p WHERE p.oid=''native_turn_publication_contract()''::regprocedure) IS DISTINCT FROM '||quote_literal(pin);
 FOREACH signature IN ARRAY ARRAY['native_turn_capture_event(jsonb)','native_turn_field_reference(uuid,uuid,uuid,text)',
  'native_turn_validate_event(jsonb)','native_turn_page_event(jsonb)','native_turn_guard_completion_debt()'] LOOP
  definition:=pg_get_functiondef(signature::regprocedure);
  IF signature='native_turn_capture_event(jsonb)' THEN
   old_fragment:=' IF '||predicate||'
  OR native_turn_publication_contract() IS NOT TRUE THEN
  RAISE EXCEPTION ''scope_source_changed'' USING ERRCODE=''42501'';END IF;';
   new_fragment:=' IF '||predicate||' THEN
  RAISE EXCEPTION ''scope_source_changed'' USING ERRCODE=''42501'';END IF;';
  ELSIF signature='native_turn_page_event(jsonb)' THEN
   old_fragment:=' IF '||predicate||' THEN
  RAISE EXCEPTION ''scope_source_changed'' USING ERRCODE=''42501'';END IF;
 IF native_turn_publication_contract() IS NOT TRUE OR ';
   new_fragment:=' IF '||predicate||' THEN
  RAISE EXCEPTION ''scope_source_changed'' USING ERRCODE=''42501'';END IF;
 IF ';
  ELSIF signature='native_turn_guard_completion_debt()' THEN
   old_fragment:='  OR '||predicate||'
  OR native_turn_publication_contract() IS NOT TRUE OR native_turn_helpers_current() IS NOT TRUE';
   new_fragment:='  OR '||predicate||' OR native_turn_helpers_current() IS NOT TRUE';
  ELSE
   old_fragment:=' IF '||predicate||'
  OR native_turn_publication_contract() IS NOT TRUE OR ';
   new_fragment:=' IF '||predicate||' OR ';
  END IF;
  IF strpos(definition,old_fragment)=0 THEN RAISE EXCEPTION 'conversation_event_contract_shape: %',signature;END IF;
  definition:=replace(definition,old_fragment,new_fragment);
  IF strpos(definition,'native_turn_publication_contract() IS NOT TRUE')>0 THEN RAISE EXCEPTION 'conversation_event_contract_remaining: %',signature;END IF;
  EXECUTE definition;
 END LOOP;
END $publication_contract_owner$;

DO $construction_errors$ DECLARE routine text;definition text;
BEGIN
 FOREACH routine IN ARRAY ARRAY['native_turn_validate_event(jsonb)','native_turn_page_event(jsonb)'] LOOP
  definition:=pg_get_functiondef(to_regprocedure(routine));
  IF strpos(definition,'native_turn_construction_unavailable')=0 THEN RAISE EXCEPTION 'conversation_error_predecessor_changed';END IF;
  EXECUTE replace(replace(definition,'native_turn_construction_unavailable','scope_source_changed'),quote_literal('PNT02'),quote_literal('42501'));
 END LOOP;
END $construction_errors$;
DO $contract$ DECLARE before_row jsonb;after_row jsonb;definition text;expected jsonb;old_literal text;start_at integer;end_at integer;relation regclass;keys text[];capture jsonb;
BEGIN
 SELECT metadata INTO STRICT before_row FROM conversation_constraint_before;
 SELECT to_jsonb(c) INTO STRICT after_row FROM pg_constraint c WHERE conrelid='native_turn_frames'::regclass AND conname='native_turn_frames_format_check';
 definition:=pg_get_functiondef('native_turn_publication_contract()'::regprocedure);
 start_at:=strpos(definition,'IS NOT DISTINCT FROM ')+length('IS NOT DISTINCT FROM ');
 end_at:=strpos(definition,'::jsonb) AND');
 old_literal:=substring(definition FROM start_at FOR end_at-start_at);
 EXECUTE 'SELECT '||old_literal||'::jsonb' INTO expected;
 IF NOT(expected->'constraints') @> jsonb_build_array(before_row) THEN RAISE EXCEPTION 'conversation_constraint_predecessor_changed';END IF;
 expected:=jsonb_set(expected,'{constraints}',(SELECT jsonb_agg(value ORDER BY (value->>'oid')::oid) FROM (
  SELECT CASE WHEN value=before_row THEN after_row ELSE value END value FROM jsonb_array_elements(expected->'constraints')) changed));
 expected:=jsonb_set(expected,'{columns}',(SELECT jsonb_agg(value ORDER BY (value->>0)::oid,(value->>1)::integer) FROM (
  SELECT value FROM jsonb_array_elements(expected->'columns')
  UNION ALL SELECT jsonb_build_array(attrelid,attnum,attname,atttypid,atttypmod,attnotnull,attidentity,attgenerated,attisdropped,attacl)
   FROM pg_attribute WHERE attrelid='native_turn_publication_work'::regclass AND attname='completion_owner' AND atttypid='uuid'::regtype AND NOT attnotnull AND NOT attisdropped AND attacl IS NULL
 ) changed));
 -- Recovery executable ownership was transferred with the authenticated flat
 -- dependency registry. Do not create a second source of executable contracts.
 IF NOT EXISTS(SELECT 1 FROM native_turn_contract_helpers h JOIN pg_proc p ON p.oid=to_regprocedure(h.signature)
  WHERE h.signature='crm_capture_erasure_effect()' AND h.fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex'))
 THEN RAISE EXCEPTION 'conversation_recovery_capture_untrusted';END IF;
 -- These six relations are already covered by the authenticated predecessor
 -- contract. Add only the reviewed recovery trigger, preserving every old row.
 FOREACH relation IN ARRAY ARRAY['native_turn_frames'::regclass,'native_turn_publication_work'::regclass,
  'native_turn_publication_events'::regclass,'native_turn_publication_seals'::regclass,
  'native_turn_publication_impossible'::regclass,'native_turn_publication_debt'::regclass] LOOP
  IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=relation AND tgname='crm_recovery_capture')
   THEN RAISE EXCEPTION 'conversation_unexpected_recovery_capture';END IF;
  SELECT array_agg(a.attname::text ORDER BY k.ord) INTO keys FROM pg_constraint p,
   unnest(p.conkey) WITH ORDINALITY k(id,ord),pg_attribute a
   WHERE p.conrelid=relation AND p.contype='p' AND a.attrelid=relation AND a.attnum=k.id;
  INSERT INTO crm_erasure_journal_targets(table_name,key_columns,capture_inserts)
   SELECT relname,coalesce(keys,'{}'),false FROM pg_class WHERE oid=relation
   ON CONFLICT(table_name) DO UPDATE SET key_columns=EXCLUDED.key_columns,capture_inserts=EXCLUDED.capture_inserts;
  EXECUTE format('CREATE TRIGGER crm_recovery_capture AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION public.crm_capture_erasure_effect()',relation);
  SELECT to_jsonb(t) INTO STRICT capture FROM pg_trigger t WHERE tgrelid=relation AND tgname='crm_recovery_capture';
  expected:=jsonb_set(expected,'{triggers}',(SELECT jsonb_agg(t ORDER BY (t->>'oid')::oid)
   FROM jsonb_array_elements((expected->'triggers')||jsonb_build_array(capture)) t));
 END LOOP;
 EXECUTE replace(definition,old_literal,quote_literal(expected::text));
END $contract$;
DO $pins$ DECLARE changed record;caller record;iterations integer:=0;ok boolean;signature text;guard_body text;guard_comparison text;guard_rows text;guard_detail text;flat record;row_sql text;rows_sql text;replacement text;
BEGIN
 LOOP
  SELECT b.oid,b.fingerprint,b.metadata->>'prosrc' old_body,p.prosrc current_body,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') current_hash INTO changed
   FROM conversation_before b JOIN pg_proc p ON p.oid=b.oid
   WHERE b.fingerprint<>encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') ORDER BY b.signature LIMIT 1;
  EXIT WHEN NOT FOUND;
  iterations:=iterations+1;IF iterations>100 THEN RAISE EXCEPTION 'conversation_pin_cycle';END IF;
  FOR caller IN SELECT p.oid,pg_get_functiondef(p.oid) definition FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.prokind='f' AND strpos(p.prosrc,changed.fingerprint)>0
    AND NOT(p.oid::regprocedure::text=ANY(${array(retiredReaders)})) LOOP
   IF NOT EXISTS(SELECT 1 FROM conversation_before b WHERE b.oid=caller.oid) THEN
    RAISE EXCEPTION 'conversation_unreviewed_pin_consumer: %',caller.oid::regprocedure;END IF;
   EXECUTE replace(caller.definition,changed.fingerprint,changed.current_hash);
  END LOOP;
  UPDATE native_turn_contract_helpers SET fingerprint=changed.current_hash WHERE fingerprint=changed.fingerprint;
  UPDATE native_retained_contract_helpers SET fingerprint=changed.current_hash WHERE fingerprint=changed.fingerprint;
  UPDATE conversation_before SET fingerprint=changed.current_hash,metadata=jsonb_set(metadata,'{prosrc}',to_jsonb(changed.current_body)) WHERE oid=changed.oid;
 END LOOP;
 UPDATE native_turn_contract_helpers h SET contract=p FROM pg_proc p WHERE p.oid=to_regprocedure(h.signature);
 ALTER TABLE native_turn_contract_helpers ALTER COLUMN contract SET NOT NULL;
 ALTER TABLE native_turn_contract_helpers DROP COLUMN fingerprint;
 IF EXISTS(SELECT 1 FROM conversation_before b JOIN pg_proc p ON p.oid=b.oid WHERE (to_jsonb(p)-'prosrc') IS DISTINCT FROM(b.metadata-'prosrc')) THEN
  RAISE EXCEPTION 'conversation_successor_metadata_changed';END IF;
 FOREACH signature IN ARRAY ARRAY['native_turn_helpers_current()','native_retained_helpers_current()','native_turn_publication_contract()',
  'application_native_worklist_helpers_current()'] LOOP
  EXECUTE 'SELECT public.'||signature INTO ok;
  IF ok IS NOT TRUE THEN
   SELECT prosrc INTO guard_body FROM pg_proc WHERE oid=to_regprocedure(signature);
   IF strpos(guard_body,'coalesce(bool_and(')>0 AND strpos(guard_body,') m(oid,')>0 THEN
    guard_comparison:=split_part(split_part(guard_body,'coalesce(bool_and(',2),'),false) FROM (VALUES ',1);
    guard_rows:=substring(guard_body FROM strpos(guard_body,'FROM (VALUES '));
    guard_rows:=left(guard_rows,length(guard_rows)-strpos(reverse(guard_rows),reverse(' JOIN pg_catalog.pg_proc p ON p.oid=m.oid'))+1);
    EXECUTE 'SELECT string_agg(p.oid::regprocedure::text,'','') '||guard_rows||' WHERE NOT('||guard_comparison||')' INTO guard_detail;
   END IF;
   RAISE EXCEPTION 'conversation_successor_contract_changed: %',signature USING DETAIL=coalesce(guard_detail,'non-function contract');
  END IF;
 END LOOP;
END $pins$;
DO $retire$ DECLARE routine text;target pg_proc;BEGIN
 FOREACH routine IN ARRAY ${array(retiredReaders)} LOOP
  SELECT * INTO STRICT target FROM pg_proc WHERE oid=to_regprocedure('public.'||routine);
  IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind='f' AND p.oid<>target.oid
   AND NOT(p.oid::regprocedure::text=ANY(${array(retiredReaders)}))
   AND(p.prosrc~('(^|[^[:alnum:]_])'||target.proname||'([^[:alnum:]_]|$)') OR strpos(p.prosrc,encode(sha256(convert_to(to_jsonb(target)::text,'UTF8')),'hex'))>0
    OR strpos(p.prosrc,target.oid::text||'::oid')>0)) THEN
   RAISE EXCEPTION 'conversation_retirement_has_consumer: %',routine USING DETAIL=(SELECT string_agg(p.oid::regprocedure::text,',') FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind='f' AND p.oid<>target.oid
   AND NOT(p.oid::regprocedure::text=ANY(${array(retiredReaders)}))
   AND(p.prosrc~('(^|[^[:alnum:]_])'||target.proname||'([^[:alnum:]_]|$)') OR strpos(p.prosrc,encode(sha256(convert_to(to_jsonb(target)::text,'UTF8')),'hex'))>0 OR strpos(p.prosrc,target.oid::text||'::oid')>0));END IF;
  EXECUTE 'DROP FUNCTION public.'||routine||' RESTRICT';
 END LOOP;
END $retire$;
DROP TABLE public.native_field_dependency_work RESTRICT;
DROP TABLE public.native_field_dependency_batches RESTRICT;
${promotionIntegrity}
COMMIT;
`
if(process.argv.includes('--check')){
 if(await readFile(target,'utf8')!==migration)throw new Error('Conversation migration differs from reviewed sources')
 console.log('Conversation migration matches source templates')
}else{await writeFile(target,migration);console.log('Generated canonical conversation publication migration')}
