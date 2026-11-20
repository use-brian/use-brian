-- [COMP:api/native-turn-frame] Canonical conversation publication.
CREATE OR REPLACE FUNCTION public.native_turn_frame_payload_shape(p jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE sources jsonb;n jsonb;kind text;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR p-ARRAY['kind','originalSources','declaredSources']<>'{}'
  OR p->>'kind' NOT IN('native_turn_frame_v1','native_turn_frame_v2') OR p->>'kind' IS NULL THEN RETURN false;END IF;
 FOREACH sources IN ARRAY ARRAY[p->'originalSources',p->'declaredSources'] LOOP
  IF jsonb_typeof(sources) IS DISTINCT FROM 'array' OR jsonb_array_length(sources) NOT BETWEEN (CASE WHEN p->>'kind'='native_turn_frame_v1' OR sources=p->'originalSources' THEN 1 ELSE 0 END) AND 4096
   OR (SELECT count(DISTINCT (v->>'resourceKind',v->>'resourceId')) FROM jsonb_array_elements(sources) v)<>jsonb_array_length(sources)
  THEN RETURN false;END IF;
  -- Resolve the source vocabulary once per distinct family, not once for
  -- every original/retained requirement in every earlier turn frame.
  FOR kind IN SELECT DISTINCT value->>'resourceKind' FROM jsonb_array_elements(sources) LOOP
   IF kind IS NULL OR (CASE WHEN p->>'kind'='native_turn_frame_v1'
    THEN kind NOT IN('session_message','session_context_revision','application_field','workspace_file')
    ELSE kind NOT IN('application_field','external_source','crm_event','private_transcript','page_event_changed','page_event_destination','page_live_changed','page_live_destination')
     AND scope_source_table(kind) IS NULL END) THEN RETURN false;END IF;
  END LOOP;
  FOR n IN SELECT value FROM jsonb_array_elements(sources) LOOP
   IF n-ARRAY['workspaceId','userId','assistantId','sensitivity','compartments','projectIds','resourceKind','resourceId','version']<>'{}'
    OR entity_derivation_envelope_valid(n) IS NOT TRUE OR NOT n ?& ARRAY['resourceKind','resourceId','version']
    OR jsonb_typeof(n->'resourceKind') IS DISTINCT FROM 'string' OR jsonb_typeof(n->'resourceId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(n->'version') IS DISTINCT FROM 'string' OR length(btrim(n->>'version')) NOT BETWEEN 1 AND 256
    OR (n->>'resourceId')::uuid IS NULL THEN RETURN false;END IF;
  END LOOP;
 END LOOP;
 RETURN p->>'kind'='native_turn_frame_v2' OR (p->'declaredSources') @> (p->'originalSources');
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN false;
END $function$;
