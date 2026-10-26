-- Preserve canonical Memory successor validation across selective historical adoption.
-- [COMP:api/application-persistence]
BEGIN;
DO $successor_parity$
DECLARE original pg_proc; successor pg_proc; expected text; legacy text; definition text;
 before text; after text; metadata jsonb;
BEGIN
 SELECT * INTO STRICT original FROM pg_proc WHERE oid='public.record_admitted_application_field_derivation(uuid,text,uuid,text,text,jsonb)'::regprocedure;
 SELECT * INTO STRICT successor FROM pg_proc WHERE oid='public.record_admitted_memory_successor_derivation(uuid,text,uuid,text,text,jsonb,uuid,text)'::regprocedure;
 -- The private clone has the canonical original's properties and only its
 -- established extra predecessor arguments. No grant or property is repaired.
 IF (to_jsonb(successor)-ARRAY['oid','proname','prosrc','pronargs','proargtypes','proargnames','proacl']) IS DISTINCT FROM
    (to_jsonb(original)-ARRAY['oid','proname','prosrc','pronargs','proargtypes','proargnames','proacl'])
  OR successor.proargnames IS DISTINCT FROM ARRAY['w','k','i','v','producer','sources','predecessor','expected_version']
  OR original.proargnames IS DISTINCT FROM ARRAY['w','k','i','v','producer','sources']
  OR successor.proacl IS NULL OR cardinality(successor.proacl)<>1
  OR EXISTS(SELECT 1 FROM aclexplode(successor.proacl) a WHERE a.grantee<>successor.proowner
   OR a.grantor<>successor.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
 THEN RAISE EXCEPTION 'Memory successor parity metadata prerequisite changed';END IF;
 metadata:=to_jsonb(successor)-'prosrc';
 expected:=original.prosrc;
 before:=$before$output.created_by_user_id IS DISTINCT FROM actor$before$;
 after:=$after$NOT EXISTS(SELECT 1 FROM memories old WHERE old.workspace_id=w AND old.id=predecessor
  AND old.scope_version::text=expected_version AND old.valid_to IS NULL AND NOT old.scope_held AND old.retracted_at IS NULL
  AND old.created_by_user_id IS NOT DISTINCT FROM output.created_by_user_id
  AND old.created_by_assistant_id IS NOT DISTINCT FROM output.created_by_assistant_id
  AND old.user_id IS NOT DISTINCT FROM output.user_id AND old.assistant_id IS NOT DISTINCT FROM output.assistant_id
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(sources) input WHERE input->>'resourceKind'='memory'
   AND input->>'resourceId'=predecessor::text AND input->>'version'=expected_version))$after$;
 IF array_length(string_to_array(expected,before),1)<>2 THEN RAISE EXCEPTION 'Memory successor parity authorship prerequisite changed';END IF;
 expected:=replace(expected,before,after);
 legacy:=expected;
 -- Reverse exactly the four measured8090 changes to recognize the only older
 -- supported clone. A fresh canonical clone is a validation-only no-op.
 before:=$before$OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(sources) s WHERE s->>'resourceKind'='application_field') THEN$before$;
 after:=$after$OR (NOT EXISTS(SELECT 1 FROM jsonb_array_elements(sources) s WHERE s->>'resourceKind'='application_field')
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(sources) s WHERE coalesce(s->>'resourceKind','') NOT IN
    ('memory','entity','entity_link','task','workspace_file','episode','knowledge_entry','kb_chunk','session_message','session_context_revision','external_source'))) THEN$after$;
 IF array_length(string_to_array(legacy,after),1)<>2 THEN RAISE EXCEPTION 'Memory successor parity canonical prerequisite changed';END IF;
 legacy:=replace(legacy,after,before);
 before:=$before$source jsonb; current jsonb; output_source jsonb; derivation uuid;$before$;
 after:=$after$source jsonb; current jsonb; output_source jsonb; derivation uuid; dependency record; dependency_count integer:=0;$after$;
 IF array_length(string_to_array(legacy,after),1)<>2 THEN RAISE EXCEPTION 'Memory successor parity canonical prerequisite changed';END IF;
 legacy:=replace(legacy,after,before);
 before:=$before$  current:=read_entity_derivation_source(w,source->>'resourceKind',(source->>'resourceId')::uuid);$before$;
 after:=$after$  IF source->>'resourceKind'='external_source' THEN
   IF external_source_retention_allowed(w,(source->>'resourceId')::uuid,source->>'version') IS NOT TRUE THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   current:=external_source_snapshot(w,(source->>'resourceId')::uuid);
  ELSE current:=read_entity_derivation_source(w,source->>'resourceKind',(source->>'resourceId')::uuid);END IF;$after$;
 IF array_length(string_to_array(legacy,after),1)<>2 THEN RAISE EXCEPTION 'Memory successor parity canonical prerequisite changed';END IF;
 legacy:=replace(legacy,after,before);
 before:=$before$ INSERT INTO workspace_access_policies(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;$before$;
 after:=$after$ -- The field trigger intentionally returns early for field-free roots.
 -- Independently close source-only ancestry here, including native/session
 -- carriers. Each chunk uses the canonical bounded reader; the distinct union
 -- below has one operation-wide 4096-dependency limit.
 FOR dependency IN
  SELECT DISTINCT dep.node_version,dep.source
   FROM generate_series(0,jsonb_array_length(sources)-1,100) AS chunks(start_at)
   CROSS JOIN LATERAL (
    SELECT array_agg(root.body->>'resourceKind' ORDER BY root.ord) AS kinds,
     array_agg((root.body->>'resourceId')::uuid ORDER BY root.ord) AS ids,
     array_agg(root.body->>'version' ORDER BY root.ord) AS versions
     FROM jsonb_array_elements(sources) WITH ORDINALITY AS root(body,ord)
     WHERE root.ord>chunks.start_at AND root.ord<=chunks.start_at+100
   ) roots
   CROSS JOIN LATERAL read_external_source_dependencies(w,roots.kinds,roots.ids,roots.versions) dep
   LIMIT 4097 LOOP
  dependency_count:=dependency_count+1;
  IF dependency_count>4096 OR dependency.source IS NULL OR dependency.source->>'version' IS DISTINCT FROM dependency.node_version
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(sources) provided WHERE provided->>'resourceKind'='external_source'
    AND provided->>'resourceId'=dependency.source->>'resourceId' AND provided->>'version'=dependency.node_version)
   OR external_source_retention_allowed(w,(dependency.source->>'resourceId')::uuid,dependency.node_version) IS NOT TRUE
   THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023'; END IF;
 END LOOP;
 INSERT INTO workspace_access_policies(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;$after$;
 IF array_length(string_to_array(legacy,after),1)<>2 THEN RAISE EXCEPTION 'Memory successor parity canonical prerequisite changed';END IF;
 legacy:=replace(legacy,after,before);
 IF successor.prosrc IS DISTINCT FROM expected AND successor.prosrc IS DISTINCT FROM legacy THEN
  RAISE EXCEPTION 'Memory successor parity body prerequisite changed';END IF;
 IF successor.prosrc IS DISTINCT FROM expected THEN
  definition:=pg_get_functiondef(successor.oid);
  IF array_length(string_to_array(definition,successor.prosrc),1)<>2 THEN RAISE EXCEPTION 'Memory successor parity definition prerequisite changed';END IF;
  EXECUTE replace(definition,successor.prosrc,expected);
 END IF;
 SELECT * INTO STRICT successor FROM pg_proc WHERE oid=successor.oid;
 IF successor.prosrc IS DISTINCT FROM expected OR (to_jsonb(successor)-'prosrc') IS DISTINCT FROM metadata THEN
  RAISE EXCEPTION 'Memory successor parity preservation failed';END IF;
END $successor_parity$;
COMMIT;
