-- [COMP:api/application-persistence] A Memory write must not invalidate its own input index.
-- A frozen query still rejects unrelated growth. Only newly derived outputs that
-- explicitly retain that exact query are omitted from its historical replay;
-- fresh queries include them normally. No observation or historical payload is rewritten.
BEGIN;
-- Only the existing SECURITY DEFINER lineage writer can stage these selectors.
-- They bridge its BEFORE INSERT source trigger, then disappear before final
-- validation. No GUC, caller flag, reusable receipt or app-role table grant.
CREATE TABLE native_memory_query_write_intents(
 derivation_id uuid NOT NULL REFERENCES scope_derivations(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 field_id uuid NOT NULL,field_version text NOT NULL,transaction_id xid8 NOT NULL,
 PRIMARY KEY(derivation_id,field_id,field_version),
 FOREIGN KEY(field_id,field_version) REFERENCES application_field_observations(resource_id,version)
);
ALTER TABLE native_memory_query_write_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON native_memory_query_write_intents FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 REVOKE ALL ON native_memory_query_write_intents FROM app_user;
END IF;END $$;
CREATE TEMP TABLE memory_query_write_predecessors ON COMMIT DROP AS
 SELECT p.oid,to_jsonb(p)-'prosrc' AS metadata,p.prosrc AS original,p.prosrc AS expected,
  encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') AS fingerprint,
  encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body_hash,
  p.prosrc AS pinned_body,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') AS pinned_fingerprint,
  encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS pinned_body_hash
 FROM pg_proc p WHERE p.oid=ANY(ARRAY[
  'application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb)'::regprocedure,
  'record_admitted_application_field_derivation(uuid,text,uuid,text,text,jsonb)'::regprocedure,
  'application_native_field_reference_helpers_current()'::regprocedure,
  'application_memory_statement_helpers_current()'::regprocedure,
  'application_native_covered_evidence_helpers_current()'::regprocedure,
  'application_native_dependency_batch_helpers_current()'::regprocedure,
  'application_empty_query_facades_current()'::regprocedure,'application_empty_query_helpers_current()'::regprocedure,
  'application_native_covered_queue_current()'::regprocedure,'application_native_context_fields_current()'::regprocedure,
  'application_native_session_query_acquisition_current()'::regprocedure,'application_native_title_acquisition_helpers_current()'::regprocedure,
  'application_native_title_group_helpers_current()'::regprocedure,'application_native_transcript_prepare_helpers_current()'::regprocedure,
  'application_native_file_capture_helpers_current()'::regprocedure,'application_native_worklist_helpers_current()'::regprocedure,
  'native_private_title_helpers_current()'::regprocedure,'native_retained_helpers_current()'::regprocedure,
  'read_native_private_title_evidence(uuid,uuid)'::regprocedure,'read_native_private_title_acquisition(uuid,uuid,uuid)'::regprocedure,
  'capture_native_session_query_stage(uuid,uuid,integer,text,jsonb,jsonb)'::regprocedure,
  'native_retained_capture_cohorts(uuid,jsonb,jsonb)'::regprocedure,'native_retained_capture_requirements(uuid,jsonb,jsonb)'::regprocedure,
  'native_turn_capture_event(jsonb)'::regprocedure,'native_turn_field_reference(uuid,uuid,uuid,text)'::regprocedure,
  'native_turn_guard_completion_debt()'::regprocedure,'native_turn_page_event(jsonb)'::regprocedure,
  'native_turn_prepare_publication(uuid,uuid,text,jsonb,jsonb)'::regprocedure,'native_turn_publication_contract()'::regprocedure,
  'native_turn_validate_event(jsonb)'::regprocedure,'prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)'::regprocedure,
  'publish_native_session_context_revision(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer)'::regprocedure,
  'read_native_covered_session_evidence(uuid,text[],uuid[],text[])'::regprocedure,
  'read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'::regprocedure,
  'read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure,
  'read_native_personal_title_group_evidence(uuid,uuid[],uuid[])'::regprocedure,
  'read_native_retained_publication_cohorts(uuid,jsonb)'::regprocedure,'read_native_retained_requirements(uuid,jsonb,jsonb)'::regprocedure,
  'read_native_retained_scope_evidence(uuid,jsonb)'::regprocedure,'read_native_retained_session_query(uuid,uuid,integer,integer)'::regprocedure,
  'read_native_session_query_evidence(uuid,uuid,integer,integer)'::regprocedure,'read_native_turn_requirements(uuid,jsonb)'::regprocedure,
  'validate_application_field_dependencies()'::regprocedure,
  'read_native_empty_query_session_title_revision(uuid,uuid,uuid)'::regprocedure,
  'read_native_file_session_title_revision(uuid,uuid,uuid)'::regprocedure,
  'read_session_context_empty_query_revision(uuid,uuid)'::regprocedure,'read_session_context_file_revision(uuid,uuid)'::regprocedure,
  'session_context_empty_query_revision_allowed(uuid,uuid)'::regprocedure,'session_context_file_revision_allowed(uuid,uuid)'::regprocedure]::oid[]);

CREATE TEMP TABLE memory_query_write_catalog(routine pg_proc) ON COMMIT DROP;
INSERT INTO memory_query_write_catalog SELECT p FROM pg_proc p JOIN memory_query_write_predecessors m ON m.oid=p.oid;

DO $memory_query_write$
DECLARE signature text;ok boolean;target regprocedure;previous record;successor text;definition text;intent_lineage text;
 before_scan constant text:=$before_scan$AND (valid_to IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(frozen->'candidates') c WHERE c->>'id'=memories.id::text AND c->>'version'=memories.scope_version::text)) ORDER BY id LOOP$before_scan$;
 after_scan constant text:=$after_scan$AND (valid_to IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(frozen->'candidates') c WHERE c->>'id'=memories.id::text AND c->>'version'=memories.scope_version::text))
  AND (EXISTS(SELECT 1 FROM jsonb_array_elements(frozen->'candidates') c WHERE c->>'id'=memories.id::text)
   OR NOT EXISTS(SELECT 1 FROM scope_derivations d
    JOIN LATERAL(SELECT s.source_id FROM scope_derivation_sources s
      WHERE s.workspace_id=d.workspace_id AND s.derivation_id=d.id AND s.source_kind='application_field'
     UNION SELECT pending.field_id FROM native_memory_query_write_intents pending
      WHERE pending.workspace_id=d.workspace_id AND pending.derivation_id=d.id
       AND pending.transaction_id=pg_current_xact_id_if_assigned()) input ON true
    JOIN application_field_resources f ON f.workspace_id=d.workspace_id AND f.id=input.source_id
    WHERE d.workspace_id=w AND d.resource_kind='memory' AND d.resource_id=memories.id
     AND f.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND f.type_key='memory' AND f.selection='query_domain'
     AND f.resource_id=application_field_resource_uuid(application_field_digest(
      jsonb_build_object('kind','memory_query_domain_v1','workspaceId',w,'domain',frozen))))) ORDER BY id LOOP$after_scan$;
 lineage_insert constant text:=$lineage_insert$ INSERT INTO workspace_access_policies(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;
 INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
  SELECT w,k,i,v,producer,output.user_id,output.assistant_id,output.sensitivity,output.compartments,output.project_ids,p.revision
   FROM workspace_access_policies p WHERE p.workspace_id=w RETURNING id INTO derivation;
 INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
  SELECT w,derivation,s->>'resourceKind',(s->>'resourceId')::uuid,s->>'version' FROM jsonb_array_elements(sources) s
   ORDER BY s->>'resourceKind',s->>'resourceId';$lineage_insert$;
 source_loop constant text:=$source_loop$ FOR source IN SELECT value FROM jsonb_array_elements(sources) ORDER BY value->>'resourceKind',value->>'resourceId' LOOP$source_loop$;
BEGIN
 IF (SELECT count(*) FROM memory_query_write_predecessors)<>49 THEN RAISE EXCEPTION 'memory_query_write_predecessor_missing';END IF;
 FOR signature IN SELECT p.oid::regprocedure::text FROM memory_query_write_predecessors m JOIN pg_proc p ON p.oid=m.oid
  WHERE p.pronargs=0 AND p.prorettype='boolean'::regtype
  UNION SELECT 'native_turn_helpers_current()' UNION SELECT 'native_turn_publication_contract()' LOOP
  EXECUTE 'SELECT '||signature INTO ok;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'memory_query_write_dependency_changed: %',signature;END IF;
 END LOOP;
 -- The two public title ports embed their private comparator's exact catalog
 -- fingerprint. Authenticate their static templates before updating that pin.
 definition:=format('(SELECT encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=%L FROM pg_catalog.pg_proc p WHERE p.oid=''public.native_private_title_helpers_current()''::regprocedure)',
  (SELECT fingerprint FROM memory_query_write_predecessors WHERE oid='native_private_title_helpers_current()'::regprocedure));
 FOR previous IN SELECT * FROM memory_query_write_predecessors WHERE oid IN(
  'read_native_private_title_evidence(uuid,uuid)'::regprocedure,'read_native_private_title_acquisition(uuid,uuid,uuid)'::regprocedure) LOOP
  IF (length(previous.original)-length(replace(previous.original,definition,'')))/length(definition)<>2
   OR encode(sha256(convert_to(replace(previous.original,definition,'(SELECT false /*__GUARD_CURRENT__*/)'),'UTF8')),'hex')
    IS DISTINCT FROM (CASE previous.oid WHEN 'read_native_private_title_evidence(uuid,uuid)'::regprocedure::oid
     THEN 'c0f49ae361ace10d72a4808c42210aa354031541bce9e4cc01b35e5904cb8c13'
     ELSE '75535170e24bdb41e6f211d965d962b3f464977117eb2c3c6b7033ea7081de99' END)
  THEN RAISE EXCEPTION 'memory_query_write_title_port_changed: %',previous.oid::regprocedure;END IF;
 END LOOP;
 -- Authenticate the two executable changes, not catalog-discovered replacement
 -- bodies. Every existing function property and ACL is retained verbatim.
 FOR previous IN SELECT * FROM memory_query_write_predecessors WHERE oid IN(
  'application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb)'::regprocedure,
  'record_admitted_application_field_derivation(uuid,text,uuid,text,text,jsonb)'::regprocedure) LOOP
  IF previous.body_hash IS DISTINCT FROM (CASE previous.oid
    WHEN 'application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb)'::regprocedure::oid
     THEN '1f5afc1d54fb3bbb09a9719cbc0b4d6b2bcd6cb5743df2143abc5abb7700a864'
    ELSE 'ad277d20b255862745d1509c40a358b30cdff08dd1169591683018ebaacb7dde' END)
   OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=previous.oid AND p.prosecdef AND p.prokind='f'
    AND p.pronamespace='public'::regnamespace AND p.proowner=(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
    AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') AND p.provolatile='v'
    AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u')
  THEN RAISE EXCEPTION 'memory_query_write_predecessor_changed: %',previous.oid::regprocedure;END IF;
 END LOOP;
 target:='application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb)'::regprocedure;
 SELECT * INTO STRICT previous FROM memory_query_write_predecessors WHERE oid=target;
 IF (length(previous.original)-length(replace(previous.original,before_scan,'')))/length(before_scan)<>1
 THEN RAISE EXCEPTION 'memory_query_write_scan_shape_changed';END IF;
 successor:=replace(previous.original,before_scan,after_scan);
 EXECUTE replace(pg_get_functiondef(target),previous.original,successor);
 UPDATE memory_query_write_predecessors SET expected=successor WHERE oid=target;

 target:='record_admitted_application_field_derivation(uuid,text,uuid,text,text,jsonb)'::regprocedure;
 SELECT * INTO STRICT previous FROM memory_query_write_predecessors WHERE oid=target;
 IF (length(previous.original)-length(replace(previous.original,lineage_insert,'')))/length(lineage_insert)<>1
  OR (length(previous.original)-length(replace(previous.original,source_loop,'')))/length(source_loop)<>1
 THEN RAISE EXCEPTION 'memory_query_write_lineage_shape_changed';END IF;
 -- The existing actor, workspace, non-owner role, new-row xmin, output scope,
 -- duplicate-source and mutation guards still precede this insertion. Publish
 -- the tentative edges before rechecking sources so the historical scan can
 -- recognize this output. ALL exact-version, label, retention and ancestry
 -- checks still run, and any failure rolls back the complete statement.
 intent_lineage:=replace(lineage_insert,' INSERT INTO scope_derivation_sources',
  $intent$ INSERT INTO native_memory_query_write_intents(derivation_id,workspace_id,field_id,field_version,transaction_id)
  SELECT derivation,w,f.id,proposed.root->>'version',pg_current_xact_id() FROM jsonb_array_elements(sources) AS proposed(root)
   JOIN application_field_resources f ON f.workspace_id=w AND f.id=(proposed.root->>'resourceId')::uuid
    AND f.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND f.type_key='memory' AND f.selection='query_domain'
   WHERE proposed.root->>'resourceKind'='application_field';
 INSERT INTO scope_derivation_sources$intent$)
  ||E'\n DELETE FROM native_memory_query_write_intents WHERE derivation_id=derivation AND transaction_id=pg_current_xact_id_if_assigned();';
 successor:=replace(replace(previous.original,lineage_insert,''),source_loop,intent_lineage||E'\n'||source_loop);
 EXECUTE replace(pg_get_functiondef(target),previous.original,successor);
 UPDATE memory_query_write_predecessors SET expected=successor WHERE oid=target;
END $memory_query_write$;

-- Repin only the explicitly enumerated established comparators and their ports.
-- Unknown pin consumers abort rather than being silently trusted/rebuilt.
DO $memory_query_write_pins$
DECLARE previous record;consumer record;body text;round integer;changed boolean;signature text;ok boolean;
 row_sql text;before_row text;after_row text;reference_body text;reference_current text;failures text[]:='{}';
 reference_oid oid:='application_native_field_reference_helpers_current()'::regprocedure;
BEGIN
 -- Use the exact existing catalog-row serializer. Original composite rows were
 -- captured before ANY change, so only whole authenticated member rows can be
 -- replaced in the reference comparator. No new member is enrolled.
 SELECT string_agg(format('format(%L,%s)', '%L::'||CASE WHEN attname='proacl' THEN 'jsonb'
   WHEN atttypid IN('pg_node_tree'::regtype,'oidvector'::regtype,'regproc'::regtype) THEN 'text' ELSE format_type(atttypid,atttypmod) END,
   CASE WHEN attname='proacl' THEN 'to_jsonb(p.proacl)' WHEN atttypid IN('pg_node_tree'::regtype,'oidvector'::regtype,'regproc'::regtype)
    THEN format('p.%I::text',attname) ELSE format('p.%I',attname) END),'||'',''||' ORDER BY attnum)
 INTO row_sql FROM pg_attribute WHERE attrelid='pg_proc'::regclass AND attnum>0 AND NOT attisdropped;
 FOR round IN 1..64 LOOP
  changed:=false;
  IF EXISTS(SELECT 1 FROM memory_query_write_predecessors m LEFT JOIN pg_proc p ON p.oid=m.oid
   WHERE p.oid IS NULL OR p.prosrc IS DISTINCT FROM m.expected OR to_jsonb(p)-'prosrc' IS DISTINCT FROM m.metadata)
  THEN RAISE EXCEPTION 'memory_query_write_metadata_changed';END IF;
  SELECT original INTO STRICT reference_body FROM memory_query_write_predecessors WHERE oid=reference_oid;
  SELECT prosrc INTO STRICT reference_current FROM pg_proc WHERE oid=reference_oid;
  FOR previous IN SELECT m.*,p.prosrc current_body,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') current_fingerprint
   FROM memory_query_write_predecessors m JOIN pg_proc p ON p.oid=m.oid WHERE m.oid<>reference_oid AND m.original IS DISTINCT FROM p.prosrc LOOP
   EXECUTE 'SELECT ''(''||'||row_sql||'||'')'' FROM (SELECT (routine).* FROM memory_query_write_catalog) p WHERE p.oid=$1'
    INTO STRICT before_row USING previous.oid;
   IF position(before_row IN reference_body)>0 THEN
    EXECUTE 'SELECT ''(''||'||row_sql||'||'')'' FROM pg_proc p WHERE p.oid=$1' INTO STRICT after_row USING previous.oid;
    reference_body:=replace(reference_body,before_row,after_row);
   END IF;
  END LOOP;
  IF reference_body IS DISTINCT FROM reference_current THEN
   EXECUTE replace(pg_get_functiondef(reference_oid),reference_current,reference_body);
   UPDATE memory_query_write_predecessors SET expected=reference_body WHERE oid=reference_oid;
   changed:=true;
  END IF;
  IF EXISTS(SELECT 1 FROM memory_query_write_predecessors m LEFT JOIN pg_proc p ON p.oid=m.oid
   WHERE p.oid IS NULL OR p.prosrc IS DISTINCT FROM m.expected OR to_jsonb(p)-'prosrc' IS DISTINCT FROM m.metadata)
  THEN RAISE EXCEPTION 'memory_query_write_metadata_changed';END IF;
  FOR previous IN SELECT m.*,p.prosrc current_body,
   encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') current_fingerprint,
   encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') current_hash
   FROM memory_query_write_predecessors m JOIN pg_proc p ON p.oid=m.oid WHERE m.pinned_body IS DISTINCT FROM p.prosrc LOOP
   FOR consumer IN SELECT p.oid,p.prosrc FROM pg_proc p WHERE p.prokind='f' AND p.oid<>previous.oid
    AND (position(quote_literal(previous.pinned_body) IN p.prosrc)>0 OR position(previous.pinned_fingerprint IN p.prosrc)>0
     OR position(previous.pinned_body_hash IN p.prosrc)>0) LOOP
    IF NOT EXISTS(SELECT 1 FROM memory_query_write_predecessors m WHERE m.oid=consumer.oid AND m.expected=consumer.prosrc
     AND m.oid NOT IN('application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb)'::regprocedure,
      'record_admitted_application_field_derivation(uuid,text,uuid,text,text,jsonb)'::regprocedure))
    THEN RAISE EXCEPTION 'memory_query_write_unknown_pin_consumer: %',consumer.oid::regprocedure;END IF;
    body:=replace(replace(replace(consumer.prosrc,quote_literal(previous.pinned_body),quote_literal(previous.current_body)),
     previous.pinned_fingerprint,previous.current_fingerprint),previous.pinned_body_hash,previous.current_hash);
    IF body IS DISTINCT FROM consumer.prosrc THEN
     EXECUTE replace(pg_get_functiondef(consumer.oid),consumer.prosrc,body);
     UPDATE memory_query_write_predecessors SET expected=body WHERE oid=consumer.oid;
     changed:=true;
    END IF;
   END LOOP;
   -- Advance the consumed baseline: a comparator may change again after a
   -- dependency is repinned later in this round. Intermediate pins must also
   -- propagate, independently of catalog iteration order.
   UPDATE memory_query_write_predecessors SET pinned_body=previous.current_body,
    pinned_fingerprint=previous.current_fingerprint,pinned_body_hash=previous.current_hash WHERE oid=previous.oid;
  END LOOP;
  EXIT WHEN NOT changed;
 END LOOP;
 IF changed THEN RAISE EXCEPTION 'memory_query_write_pin_limit';END IF;
 FOR previous IN SELECT m.*,p.prosrc current_body,
  encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') current_fingerprint
  FROM memory_query_write_predecessors m JOIN pg_proc p ON p.oid=m.oid WHERE m.original IS DISTINCT FROM p.prosrc LOOP
  UPDATE native_turn_contract_helpers h SET fingerprint=previous.current_fingerprint
   WHERE to_regprocedure('public.'||h.signature)::oid=previous.oid AND h.fingerprint=previous.fingerprint;
  UPDATE native_retained_contract_helpers h SET fingerprint=previous.current_fingerprint
   WHERE to_regprocedure('public.'||h.signature)::oid=previous.oid AND h.fingerprint=previous.fingerprint;
 END LOOP;
 IF EXISTS(SELECT 1 FROM memory_query_write_predecessors m LEFT JOIN pg_proc p ON p.oid=m.oid
  WHERE p.oid IS NULL OR p.prosrc IS DISTINCT FROM m.expected OR to_jsonb(p)-'prosrc' IS DISTINCT FROM m.metadata)
 THEN RAISE EXCEPTION 'memory_query_write_successor_metadata_changed';END IF;
 FOR signature IN SELECT p.oid::regprocedure::text FROM memory_query_write_predecessors m JOIN pg_proc p ON p.oid=m.oid
  WHERE p.pronargs=0 AND p.prorettype='boolean'::regtype
  UNION SELECT 'native_turn_helpers_current()' UNION SELECT 'native_turn_publication_contract()' LOOP
  EXECUTE 'SELECT '||signature INTO ok;
  IF ok IS NOT TRUE THEN failures:=array_append(failures,signature);END IF;
 END LOOP;
 IF cardinality(failures)>0 THEN RAISE EXCEPTION 'memory_query_write_successor_changed: %',failures;END IF;
END $memory_query_write_pins$;
COMMIT;
