-- [COMP:api/native-chat-read-cost] Plan mixed field ancestry through complete canonical cohorts.
-- Returns immutable dependency metadata only; downstream current admission and
-- complete caller footprint checks remain unchanged. Applied predecessors stay immutable.
BEGIN;
DO $mixed_field_planning$
DECLARE target regprocedure:='public.read_native_session_field_dependencies(uuid,text[],uuid[],text[])'::regprocedure;
 routine pg_proc;original text;changed text;guard_signature text;guard_ok boolean;
 declaration_old text:=$planning_declaration_old$DECLARE dependency record;$planning_declaration_old$;
 declaration_new text:=$planning_declaration_new$DECLARE planning_memory_kinds text[];planning_memory_ids uuid[];planning_memory_versions text[];
 planning_native_kinds text[];planning_native_ids uuid[];planning_native_versions text[];planning_eligible boolean;
 planning_context jsonb;planning_memory_context jsonb;planning_lineage jsonb;planning_rows jsonb;planning_memory_rows jsonb;planning_native_rows jsonb;
 planning_memory_proof jsonb;planning_native_proof jsonb;planning_native_roots jsonb;
 dependency record;$planning_declaration_new$;
 anchor text:=$planning_anchor$BEGIN

 -- A native immutable title$planning_anchor$;
 branch text:=$planning_branch$ -- Mixed native ancestry discovery is query planning only. Each unchanged
 -- canonical reader must admit its entire original cohort. No allow packet,
 -- current-source receipt, source descriptor or root may be supplied by callers.
 IF kinds IS NOT NULL AND ids IS NOT NULL AND versions IS NOT NULL AND cardinality(ids) BETWEEN 2 AND 100
  AND cardinality(kinds)=cardinality(ids) AND cardinality(versions)=cardinality(ids)
  AND array_position(kinds,NULL) IS NULL AND array_position(ids,NULL) IS NULL AND array_position(versions,NULL) IS NULL
  AND actor IS NOT NULL AND nullif(current_setting('app.application_id',true),'') IS NULL
  AND nullif(current_setting('app.public_share_root',true),'') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_roles login JOIN pg_class owned ON owned.oid='public.session_messages'::regclass WHERE login.rolname=session_user
   AND(login.rolsuper OR login.rolbypassrls OR pg_has_role(login.oid,owned.relowner,'USAGE')))
  AND native_turn_helpers_current() IS TRUE AND application_memory_statement_helpers_current() IS TRUE
  AND (SELECT count(*)=count(DISTINCT (root.kind,root.id,root.version)) FROM unnest(kinds,ids,versions) root(kind,id,version)) THEN
  SELECT array_agg(root.kind ORDER BY root.ord) FILTER(WHERE f.type_key='memory'),
   array_agg(root.id ORDER BY root.ord) FILTER(WHERE f.type_key='memory'),
   array_agg(root.version ORDER BY root.ord) FILTER(WHERE f.type_key='memory'),
   array_agg(root.kind ORDER BY root.ord) FILTER(WHERE f.type_key IS DISTINCT FROM 'memory'),
   array_agg(root.id ORDER BY root.ord) FILTER(WHERE f.type_key IS DISTINCT FROM 'memory'),
   array_agg(root.version ORDER BY root.ord) FILTER(WHERE f.type_key IS DISTINCT FROM 'memory'),
   bool_and(CASE WHEN root.kind='application_field' THEN f.id IS NOT NULL
    AND f.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND f.selected_version IS NULL
    AND (f.type_key='memory' AND f.selection='query_domain' OR f.type_key IN('session_message','session_message_annotation')
     AND f.selection IN('read','query','identity','query_domain'))
    ELSE root.kind IN('session_message','session_context_revision') END)
  INTO planning_memory_kinds,planning_memory_ids,planning_memory_versions,planning_native_kinds,planning_native_ids,planning_native_versions,planning_eligible
  FROM unnest(kinds,ids,versions) WITH ORDINALITY root(kind,id,version,ord)
  LEFT JOIN application_field_resources f ON root.kind='application_field' AND f.workspace_id=w AND f.id=root.id;
  IF planning_eligible IS TRUE AND cardinality(planning_memory_ids)>0 AND cardinality(planning_native_ids)>0 THEN
   planning_context:=native_turn_context();planning_memory_context:=application_memory_query_context(w);
   SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO planning_lineage
    FROM application_scope_lineage(w,kinds,ids,versions) n;
   -- A Memory cohort with transcript/external ancestry is not this planning profile.
   IF planning_memory_context IS NOT NULL AND jsonb_array_length(planning_lineage)<=4096
    AND NOT EXISTS(SELECT 1 FROM application_scope_lineage(w,planning_memory_kinds,planning_memory_ids,planning_memory_versions) n
     LEFT JOIN application_field_resources f ON n.kind='application_field' AND f.workspace_id=w AND f.id=n.id
     WHERE n.kind NOT IN('application_field','application_query_domain','memory') OR n.kind='application_field'
      AND (f.id IS NULL OR f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR f.type_key<>'memory')) THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('version',d.node_version,'source',d.source) ORDER BY d.node_version,d.source::text),'[]')
     INTO planning_rows FROM read_application_field_dependencies(w,kinds,ids,versions) d;
    SELECT coalesce(jsonb_agg(jsonb_build_object('version',d.node_version,'source',d.source) ORDER BY d.node_version,d.source::text),'[]')
     INTO planning_memory_rows FROM read_application_field_dependencies(w,planning_memory_kinds,planning_memory_ids,planning_memory_versions) d;
    SELECT coalesce(jsonb_agg(jsonb_build_object('version',d.node_version,'source',d.source) ORDER BY d.node_version,d.source::text),'[]')
     INTO planning_native_rows FROM read_application_field_dependencies(w,planning_native_kinds,planning_native_ids,planning_native_versions) d;
    planning_memory_proof:=read_native_attended_memory_evidence(w,planning_memory_kinds,planning_memory_ids,planning_memory_versions);
    SELECT coalesce(jsonb_agg(jsonb_build_object('kind',root.kind,'id',root.id,'version',root.version) ORDER BY root.ord),'[]')
     INTO planning_native_roots FROM unnest(planning_native_kinds,planning_native_ids,planning_native_versions) WITH ORDINALITY root(kind,id,version,ord);
    planning_native_proof:=read_native_turn_scope_evidence(w,planning_native_roots);
    IF planning_memory_proof->>'admitted'='true' AND planning_native_proof->>'admitted'='true'
     AND jsonb_typeof(planning_memory_proof->'immutable')='array' AND jsonb_typeof(planning_native_proof->'immutable')='array'
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements((planning_memory_proof->'immutable')||(planning_native_proof->'immutable')) descriptor
      GROUP BY descriptor->>'resourceKind',descriptor->>'resourceId',descriptor->>'version' HAVING count(DISTINCT descriptor)>1) THEN
     -- Each cohort's exact immutable field metadata must come from that cohort's
     -- complete proof; a descriptor from the other proof supplies no admission.
     planning_eligible:=NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(planning_memory_rows) entry CROSS JOIN LATERAL(SELECT entry->'source' source,entry->>'version' node_version) d
       WHERE d.source IS NULL OR d.source->>'resourceKind' IS DISTINCT FROM 'application_field'
        OR d.source->>'version' IS DISTINCT FROM d.node_version OR d.source->>'workspaceId' IS DISTINCT FROM w::text
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(planning_memory_proof->'immutable') actual WHERE actual=d.source)
      UNION ALL
      SELECT 1 FROM jsonb_array_elements(planning_native_rows) entry CROSS JOIN LATERAL(SELECT entry->'source' source,entry->>'version' node_version) d
       WHERE d.source IS NULL OR d.source->>'resourceKind' IS DISTINCT FROM 'application_field'
        OR d.source->>'version' IS DISTINCT FROM d.node_version OR d.source->>'workspaceId' IS DISTINCT FROM w::text
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(planning_native_proof->'immutable') actual WHERE actual=d.source));
     IF planning_eligible IS TRUE AND planning_rows IS NOT DISTINCT FROM (
       SELECT coalesce(jsonb_agg(value ORDER BY value->>'version',(value->'source')::text),'[]')
       FROM(SELECT DISTINCT value FROM jsonb_array_elements(planning_memory_rows||planning_native_rows)) combined)
      AND native_turn_context() IS NOT DISTINCT FROM planning_context
      AND application_memory_query_context(w) IS NOT DISTINCT FROM planning_memory_context
      AND native_turn_helpers_current() IS TRUE AND application_memory_statement_helpers_current() IS TRUE
      AND planning_lineage IS NOT DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]')
       FROM application_scope_lineage(w,kinds,ids,versions) n)
      AND planning_rows IS NOT DISTINCT FROM (SELECT coalesce(jsonb_agg(jsonb_build_object('version',d.node_version,'source',d.source)
       ORDER BY d.node_version,d.source::text),'[]') FROM read_application_field_dependencies(w,kinds,ids,versions) d) THEN
      RETURN QUERY SELECT value->>'version',value->'source' FROM jsonb_array_elements(planning_rows);
      RETURN;
     END IF;
    END IF;
   END IF;
  END IF;
 END IF;
 -- Unsupported planning retains every original root and the original evaluator.
$planning_branch$;
BEGIN
 SELECT * INTO STRICT routine FROM pg_proc WHERE oid=target;
 original:=routine.prosrc;
 IF encode(sha256(convert_to(original,'UTF8')),'hex') IS DISTINCT FROM 'fc663c87b15ec0a570ca3f75d97e8f1add1ea158fa68bfb13930c361235afbbe'
  OR routine.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.session_messages'::regclass)
  OR routine.pronamespace<>'public'::regnamespace OR routine.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR routine.proargdefaults IS NOT NULL
  OR to_jsonb(routine)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace','proargdefaults'] IS DISTINCT FROM $planning_metadata${"probin":null,"procost":100,"prokind":"f","proname":"read_native_session_field_dependencies","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t","t"],"proargnames":["w","kinds","ids","versions","node_version","source"],"proargtypes":["2950","1009","2951","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","1009","2951","1009","25","3802"],"pronargdefaults":0}$planning_metadata$::jsonb
  OR NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) a
   WHERE a.grantee=(SELECT oid FROM pg_roles WHERE rolname='app_user') AND a.grantor=routine.proowner AND a.privilege_type='EXECUTE' AND NOT a.is_grantable)
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) a
   WHERE a.grantee NOT IN(routine.proowner,(SELECT oid FROM pg_roles WHERE rolname='app_user'))
    OR a.grantor<>routine.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
 THEN RAISE EXCEPTION 'mixed_field_planning_predecessor_changed';END IF;
 -- This target is outside the frozen native guard rosters. Refuse an unexpected
 -- quoted-body/fingerprint consumer instead of silently introducing an unpinned successor.
 IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.prokind='f' AND p.oid<>target AND (
  position(quote_literal(original) IN p.prosrc)>0
  OR position(encode(sha256(convert_to(to_jsonb(routine)::text,'UTF8')),'hex') IN p.prosrc)>0
  OR position(encode(sha256(convert_to(original,'UTF8')),'hex') IN p.prosrc)>0))
 THEN RAISE EXCEPTION 'mixed_field_planning_unexpected_pin_consumer';END IF;
 FOREACH guard_signature IN ARRAY ARRAY['native_turn_helpers_current()','native_turn_publication_contract()',
  'application_native_worklist_helpers_current()','application_native_dependency_batch_helpers_current()',
  'application_native_field_reference_helpers_current()','application_memory_statement_helpers_current()'] LOOP
  EXECUTE 'SELECT public.'||guard_signature INTO guard_ok;
  IF guard_ok IS NOT TRUE THEN RAISE EXCEPTION 'mixed_field_planning_dependency_changed: %',guard_signature;END IF;
 END LOOP;
 IF (length(original)-length(replace(original,declaration_old,'')))/length(declaration_old)<>1
  OR (length(original)-length(replace(original,anchor,'')))/length(anchor)<>1
 THEN RAISE EXCEPTION 'mixed_field_planning_splice_changed';END IF;
 changed:=replace(replace(original,declaration_old,declaration_new),anchor,'BEGIN'||chr(10)||branch||chr(10)||' -- A native immutable title');
 IF encode(sha256(convert_to(changed,'UTF8')),'hex') IS DISTINCT FROM 'ea0ae981b22d36f0569711b02414516c6914cb1ef3bddbd2da120d9e9985df22'
 THEN RAISE EXCEPTION 'mixed_field_planning_successor_changed';END IF;
 EXECUTE replace(pg_get_functiondef(target),original,changed);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=target) IS DISTINCT FROM to_jsonb(routine)-'prosrc'
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=target) IS DISTINCT FROM 'ea0ae981b22d36f0569711b02414516c6914cb1ef3bddbd2da120d9e9985df22'
 THEN RAISE EXCEPTION 'mixed_field_planning_metadata_changed';END IF;
 FOREACH guard_signature IN ARRAY ARRAY['native_turn_helpers_current()','native_turn_publication_contract()',
  'application_native_worklist_helpers_current()','application_native_dependency_batch_helpers_current()',
  'application_native_field_reference_helpers_current()','application_memory_statement_helpers_current()'] LOOP
  EXECUTE 'SELECT public.'||guard_signature INTO guard_ok;
  IF guard_ok IS NOT TRUE THEN RAISE EXCEPTION 'mixed_field_planning_final_dependency_changed: %',guard_signature;END IF;
 END LOOP;
END $mixed_field_planning$;
COMMIT;
