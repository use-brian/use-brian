BEGIN;
-- [COMP:corrections/retraction-store] Reason bytes retain their actual inputs.
-- Applied writer bodies remain unchanged. The eight-argument port becomes private.
DO $$ BEGIN
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc
  WHERE oid='public.retract_admitted_native_memory(uuid,uuid,text,uuid,uuid,text,text,timestamptz)'::regprocedure)
  IS DISTINCT FROM '477885b37b23a3b9bfde20f20083ec4d923b6cddba2c65cb4e05c34027884394' THEN RAISE EXCEPTION 'Memory retraction input prerequisite changed';END IF;
END $$;
CREATE FUNCTION retract_admitted_native_memory(w uuid,i uuid,v text,acting uuid,session uuid,context_hash text,reason text,at_time timestamptz,reason_inputs jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE old memories;new_version text;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 context jsonb;source jsonb;policy jsonb;mask jsonb;roots jsonb;receipt uuid;reason_source jsonb;current_source jsonb;expanded jsonb;
 fields text[]:=ARRAY['retracted_at','retracted_reason','retracted_by','valid_to'];
BEGIN
 PERFORM id FROM workspaces WHERE id=w FOR UPDATE;
 context:=application_memory_query_context(w);
 IF context IS NULL OR actor IS NULL OR v IS NULL OR acting IS NULL OR session IS NULL
  OR acting::text IS DISTINCT FROM nullif(current_setting('app.v2_assistant_id',true),'')
  OR context_hash IS NULL OR context_hash !~ '^[a-f0-9]{64}$' OR at_time IS NULL OR reason IS NULL OR btrim(reason)=''
  OR NOT EXISTS(SELECT 1 FROM sessions s WHERE s.id=session AND s.workspace_id=w AND s.user_id=actor AND s.assistant_id=acting) THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 SELECT * INTO old FROM memories WHERE workspace_id=w AND id=i FOR UPDATE;
 source:=read_admitted_native_scope_snapshot(w,'memory',i);
 IF NOT FOUND OR old.scope_version::text IS DISTINCT FROM v OR old.valid_to IS NOT NULL OR old.retracted_at IS NOT NULL
  OR source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR source->>'version' IS DISTINCT FROM v
  OR application_query_scope_admits_point(context->'bounds',source) IS NOT TRUE
  OR application_memory_field_state(w,i,fields) IS NULL
  OR member_operation_scope_allows(w,old.sensitivity,old.compartments,true) IS NOT TRUE
  OR agent_mutation_scope_allows(old.compartments) IS NOT TRUE
  OR application_canonical_ancestry_allowed(w,'memory',i,v,true) IS NOT TRUE THEN
  RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 policy:=application_native_field_contract_for(w,'{"kind":"native","moduleKey":"native"}','memory',i::text);
 IF policy->>'registered'='false' THEN
  mask:=application_native_member_field_permissions(w,context->'policy',actor);
 ELSE
  mask:=read_native_application_field_mask(w,'{"kind":"native","moduleKey":"native"}','memory',i::text,v);
  mask:=jsonb_build_object('write',mask->'writeFields');
 END IF;
 IF mask IS NULL OR NOT coalesce(to_jsonb(fields)<@(mask->'write'),false) THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(node) ORDER BY node.kind,node.id,node.version),'[]') INTO roots
  FROM application_scope_lineage(w,ARRAY['memory'],ARRAY[i],ARRAY[v]) node;
 -- The trusted host supplies actual accumulated evidence. It cannot confer
 -- source authority: every input is independently re-read and revalidated here.
 IF reason_inputs IS NULL OR jsonb_typeof(reason_inputs) IS DISTINCT FROM 'object'
  OR reason_inputs-ARRAY['sources','sensitivity','compartments','projectIds']<>'{}'::jsonb
  OR jsonb_typeof(reason_inputs->'sources') IS DISTINCT FROM 'array'
  OR jsonb_array_length(reason_inputs->'sources') NOT BETWEEN 1 AND 1000
  OR reason_inputs->>'sensitivity' NOT IN('public','internal','confidential')
  OR jsonb_typeof(reason_inputs->'sensitivity') IS DISTINCT FROM 'string'
  OR jsonb_typeof(reason_inputs->'compartments') IS DISTINCT FROM 'array'
  OR jsonb_typeof(reason_inputs->'projectIds') IS DISTINCT FROM 'array'
  OR sensitivity_rank(reason_inputs->>'sensitivity')>sensitivity_rank(old.sensitivity)
  OR NOT to_jsonb(old.compartments)@>(reason_inputs->'compartments')
  OR NOT to_jsonb(old.project_ids)@>(reason_inputs->'projectIds') THEN
  RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
 IF (SELECT count(DISTINCT (s->>'resourceKind',s->>'resourceId')) FROM jsonb_array_elements(reason_inputs->'sources') s)
  <>jsonb_array_length(reason_inputs->'sources') THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 FOR reason_source IN SELECT value FROM jsonb_array_elements(reason_inputs->'sources') ORDER BY value->>'resourceKind',value->>'resourceId' LOOP
  IF entity_derivation_envelope_valid(reason_source) IS NOT TRUE OR reason_source->>'workspaceId' IS DISTINCT FROM w::text
   OR jsonb_typeof(reason_source->'resourceKind') IS DISTINCT FROM 'string' OR jsonb_typeof(reason_source->'resourceId') IS DISTINCT FROM 'string'
   OR jsonb_typeof(reason_source->'version') IS DISTINCT FROM 'string' OR btrim(reason_source->>'version')='' THEN
   RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
  IF reason_source->>'resourceKind'='external_source' THEN
   IF external_source_retention_allowed(w,(reason_source->>'resourceId')::uuid,reason_source->>'version') IS NOT TRUE THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   current_source:=external_source_snapshot(w,(reason_source->>'resourceId')::uuid);
  ELSE
   current_source:=read_entity_derivation_source(w,reason_source->>'resourceKind',(reason_source->>'resourceId')::uuid);
  END IF;
  IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false'
   OR current_source->>'version' IS DISTINCT FROM reason_source->>'version'
   OR current_source->>'validTo' IS NOT NULL OR current_source->>'retractedAt' IS NOT NULL
   OR (current_source->'workspaceId',current_source->'userId',current_source->'assistantId',current_source->'sensitivity')
    IS DISTINCT FROM (reason_source->'workspaceId',reason_source->'userId',reason_source->'assistantId',reason_source->'sensitivity')
   OR NOT (current_source->'compartments')@>(reason_source->'compartments') OR NOT (reason_source->'compartments')@>(current_source->'compartments')
   OR NOT (current_source->'projectIds')@>(reason_source->'projectIds') OR NOT (reason_source->'projectIds')@>(current_source->'projectIds')
   OR application_canonical_ancestry_allowed(w,reason_source->>'resourceKind',(reason_source->>'resourceId')::uuid,reason_source->>'version',true) IS NOT TRUE THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF reason_source->>'userId' IS NOT NULL AND reason_source->>'userId' IS DISTINCT FROM old.user_id::text
    AND NOT (reason_source->>'userId'=actor::text AND old.user_id IS NULL)
   OR sensitivity_rank(reason_source->>'sensitivity')>sensitivity_rank(old.sensitivity)
   OR NOT to_jsonb(old.compartments)@>(reason_source->'compartments') OR NOT to_jsonb(old.project_ids)@>(reason_source->'projectIds') THEN
   RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(node)),'[]') INTO expanded FROM application_scope_lineage(w,
   ARRAY[reason_source->>'resourceKind'],ARRAY[(reason_source->>'resourceId')::uuid],ARRAY[reason_source->>'version']) node;
  SELECT coalesce(jsonb_agg(value ORDER BY value->>'kind',value->>'id',value->>'version'),'[]') INTO roots
   FROM (SELECT DISTINCT value FROM jsonb_array_elements(roots||expanded)) unique_roots;
  IF jsonb_array_length(roots)>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='22023';END IF;
 END LOOP;
 -- Keep the ordinary semantic version advance and descendant invalidation.
 UPDATE memories SET retracted_at=at_time,retracted_reason=reason,retracted_by=actor,valid_to=COALESCE(valid_to,at_time)
  WHERE workspace_id=w AND id=i AND scope_version::text=v AND valid_to IS NULL AND retracted_at IS NULL
  RETURNING scope_version::text INTO new_version;
 IF NOT FOUND OR new_version IS DISTINCT FROM (old.scope_version+1)::text THEN
  RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='40001';END IF;
 -- Insert after the factual invalidation; this is a receipt of that operation,
 -- not a new live derivation of the withdrawn fact or a retained old body.
 INSERT INTO correction_audit(workspace_id,action,primitive,row_id,actor_user_id,reason,scope_held,native_memory_transition)
 VALUES(w,'retract','memory',i,actor,reason,true,jsonb_build_object('kind','native_memory_retract_v1',
  'priorVersion',v,'resultVersion',new_version,'actorId',actor,'assistantId',acting,'sessionId',session,
  'contextFingerprint',context_hash,'writeFields',fields,'reasonEvidence',reason_inputs,'originalRoots',roots,'transactionId',pg_current_xact_id()::text))
 RETURNING id INTO receipt;
 RETURN receipt;
END $$;
REVOKE ALL ON FUNCTION retract_admitted_native_memory(uuid,uuid,text,uuid,uuid,text,text,timestamptz,jsonb) FROM PUBLIC;
DO $$ DECLARE owner_name text;BEGIN
 SELECT pg_get_userbyid(proowner) INTO owner_name FROM pg_proc WHERE oid='public.retract_admitted_native_memory(uuid,uuid,text,uuid,uuid,text,text,timestamptz)'::regprocedure;
 EXECUTE format('ALTER FUNCTION public.retract_admitted_native_memory(uuid,uuid,text,uuid,uuid,text,text,timestamptz,jsonb) OWNER TO %I',owner_name);
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  REVOKE ALL ON FUNCTION retract_admitted_native_memory(uuid,uuid,text,uuid,uuid,text,text,timestamptz) FROM app_user;
  GRANT EXECUTE ON FUNCTION retract_admitted_native_memory(uuid,uuid,text,uuid,uuid,text,text,timestamptz,jsonb) TO app_user;
 END IF;
END $$;
COMMIT;
