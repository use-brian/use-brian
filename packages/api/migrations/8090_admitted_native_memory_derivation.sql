-- Existing native memory lineage writer, extended to source-only compositions.
-- Actor/new-row/field/label guards and function ACL/search path are preserved.
-- [COMP:api/application-persistence]
BEGIN;
DO $memory_derivation$
DECLARE definition text;before text;after text;
BEGIN
 definition:=pg_get_functiondef('public.record_admitted_application_field_derivation(uuid,text,uuid,text,text,jsonb)'::regprocedure);
 before:=$before$OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(sources) s WHERE s->>'resourceKind'='application_field') THEN$before$;
 after:=$after$OR (NOT EXISTS(SELECT 1 FROM jsonb_array_elements(sources) s WHERE s->>'resourceKind'='application_field')
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(sources) s WHERE coalesce(s->>'resourceKind','') NOT IN
    ('memory','entity','entity_link','task','workspace_file','episode','knowledge_entry','kb_chunk','session_message','session_context_revision','external_source'))) THEN$after$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native memory derivation prerequisite changed';END IF;
 definition:=replace(definition,before,after);
 before:=$before$source jsonb; current jsonb; output_source jsonb; derivation uuid;$before$;
 after:=$after$source jsonb; current jsonb; output_source jsonb; derivation uuid; dependency record; dependency_count integer:=0;$after$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native memory derivation declaration changed';END IF;
 definition:=replace(definition,before,after);
 before:=$before$  current:=read_entity_derivation_source(w,source->>'resourceKind',(source->>'resourceId')::uuid);$before$;
 after:=$after$  IF source->>'resourceKind'='external_source' THEN
   IF external_source_retention_allowed(w,(source->>'resourceId')::uuid,source->>'version') IS NOT TRUE THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   current:=external_source_snapshot(w,(source->>'resourceId')::uuid);
  ELSE current:=read_entity_derivation_source(w,source->>'resourceKind',(source->>'resourceId')::uuid);END IF;$after$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native memory derivation source reader changed';END IF;
 definition:=replace(definition,before,after);
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
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native memory derivation insertion changed';END IF;
 EXECUTE replace(definition,before,after);
END $memory_derivation$;
COMMIT;
