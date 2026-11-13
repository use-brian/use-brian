CREATE OR REPLACE FUNCTION public.native_turn_prepare_publication(w uuid, s uuid, producer text, sources jsonb, target jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE parent jsonb;proof jsonb;roots jsonb;declared jsonb;source jsonb;current_source jsonb;
 actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;tier text;teams text[];projects uuid[];
BEGIN
 IF native_turn_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 parent:=lock_native_session_context_publication(w,s);
 IF jsonb_typeof(sources) IS DISTINCT FROM 'array' OR jsonb_array_length(sources) NOT BETWEEN 1 AND 4096
  OR length(btrim(producer)) NOT BETWEEN 1 AND 256 OR entity_derivation_envelope_valid(target) IS NOT TRUE
  OR target->>'workspaceId' IS DISTINCT FROM w::text OR target->>'assistantId' IS NOT NULL
  OR target->>'userId' IS NOT NULL AND target->>'userId' IS DISTINCT FROM actor::text
  OR parent->>'userId' IS NOT NULL AND parent->>'userId' IS DISTINCT FROM target->>'userId' THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 -- Initial native profile retains exact current versions. Other D1 cases use the original writer.
 IF target->'userId' IS DISTINCT FROM parent->'userId' OR EXISTS(SELECT 1 FROM jsonb_array_elements(sources) n
  WHERE n->>'resourceKind' NOT IN('session_message','session_context_revision','application_field','workspace_file')) THEN RETURN NULL;END IF;
 FOR source IN SELECT value FROM jsonb_array_elements(sources) LOOP
  IF entity_derivation_envelope_valid(source) IS NOT TRUE OR source->>'workspaceId' IS DISTINCT FROM w::text
   OR jsonb_typeof(source->'version') IS DISTINCT FROM 'string' OR length(btrim(source->>'version')) NOT BETWEEN 1 AND 256
   OR (source->>'resourceId')::uuid IS NULL THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 END LOOP;
 SELECT jsonb_agg(jsonb_build_object('kind',n->'resourceKind','id',n->'resourceId','version',n->'version')) INTO roots FROM jsonb_array_elements(sources) n;
 -- Authenticate the separate retained contract before executing its code.
 IF (SELECT count(*)=1 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='__RETAINED_GUARD_FINGERPRINT__'),false)
  FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_retained_helpers_current()')) THEN
  IF native_retained_helpers_current() IS TRUE THEN
  proof:=read_native_retained_requirements(w,roots,'[]'::jsonb);
  IF (SELECT count(*)=1 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='__RETAINED_GUARD_FINGERPRINT__'),false)
   FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_retained_helpers_current()')) IS NOT TRUE
  THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
  IF native_retained_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
 END IF;
 END IF;
 IF proof->>'available' IS DISTINCT FROM 'true' THEN proof:=read_native_turn_compact_requirements(w,roots,'[]'::jsonb);END IF;
 IF proof->>'available' IS DISTINCT FROM 'true' THEN RETURN NULL;END IF;
 SELECT jsonb_agg(n ORDER BY n::text) INTO declared FROM(SELECT DISTINCT value n FROM jsonb_array_elements(sources||(proof->'immutable'))) all_sources;
 IF jsonb_array_length(declared)>4096 OR (SELECT count(DISTINCT(n->>'resourceKind',n->>'resourceId')) FROM jsonb_array_elements(declared) n)<>jsonb_array_length(declared)
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 tier:=CASE WHEN sensitivity_rank(target->>'sensitivity')>sensitivity_rank(parent->>'sensitivity') THEN target->>'sensitivity' ELSE parent->>'sensitivity' END;
 teams:=ARRAY(SELECT DISTINCT value FROM jsonb_array_elements_text((parent->'compartments')||(target->'compartments')) value ORDER BY value);
 projects:=ARRAY(SELECT DISTINCT value::uuid FROM jsonb_array_elements_text((parent->'projectIds')||(target->'projectIds')) value ORDER BY value::uuid);
 FOR source IN SELECT value FROM jsonb_array_elements(declared) LOOP
  SELECT n INTO current_source FROM jsonb_array_elements(proof->'current') n
  WHERE n->>'resourceKind'=source->>'resourceKind' AND n->>'resourceId'=source->>'resourceId';
  IF current_source IS NULL OR current_source IS DISTINCT FROM source THEN RETURN NULL;END IF;
  IF source->>'userId' IS NOT NULL AND source->'userId' IS DISTINCT FROM target->'userId' THEN RETURN NULL;END IF;
  IF source->>'userId' IS NOT NULL AND source->>'userId' IS DISTINCT FROM actor::text THEN
   RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
  IF sensitivity_rank(source->>'sensitivity')>sensitivity_rank(tier) THEN tier:=source->>'sensitivity';END IF;
  teams:=ARRAY(SELECT DISTINCT value FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(source->'compartments'))) value ORDER BY value);
  projects:=ARRAY(SELECT DISTINCT value FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(source->'projectIds')::uuid)) value ORDER BY value);
 END LOOP;
 IF member_operation_scope_allows(w,tier,teams,true) IS NOT TRUE OR agent_mutation_scope_allows(teams) IS NOT TRUE
  OR agent_read_scope_allows(tier,teams,projects) IS NOT TRUE THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('scope',jsonb_build_object('workspaceId',w,'userId',target->'userId','assistantId',NULL,
  'sensitivity',tier,'compartments',teams,'projectIds',projects),'retained',declared,
  'proof',jsonb_build_object('validUntil',proof->'validUntil','admitted',true,'immutable',proof->'immutable','current',proof->'current'));
END $function$
