BEGIN;
-- [COMP:corrections/retraction-store] Exact native fact invalidation and audit.
-- No Memory payload or alternate permission store is introduced.
ALTER TABLE correction_audit ADD COLUMN native_memory_transition jsonb;
CREATE UNIQUE INDEX native_memory_retraction_receipt_unique ON correction_audit(workspace_id,row_id)
 WHERE native_memory_transition IS NOT NULL;

-- SECURITY INVOKER is essential: direct app-user INSERTs must not inherit the
-- canonical writer's owner merely by entering this trigger.
CREATE FUNCTION guard_native_memory_retraction_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE canonical_owner oid;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.native_memory_transition IS NULL THEN RETURN NEW;END IF;
  SELECT proowner INTO canonical_owner FROM pg_proc
   WHERE oid=to_regprocedure('public.retract_admitted_native_memory(uuid,uuid,text,uuid,uuid,text,text,timestamptz)');
  IF canonical_owner IS NULL OR current_user::regrole::oid IS DISTINCT FROM canonical_owner
   OR current_user=session_user OR NEW.action<>'retract' OR NEW.primitive<>'memory'
   OR NEW.native_memory_transition->>'kind' IS DISTINCT FROM 'native_memory_retract_v1' THEN
   RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN
  IF OLD.native_memory_transition IS NULL OR NOT EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN RETURN OLD;END IF;
  RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';
 END IF;
 IF OLD.native_memory_transition IS NULL AND NEW.native_memory_transition IS NULL THEN RETURN NEW;END IF;
 IF NEW.native_memory_transition IS DISTINCT FROM OLD.native_memory_transition
  OR (to_jsonb(NEW)-ARRAY['scope_held','scope_version','reason','ticket_reference','row_snapshot','detail'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['scope_held','scope_version','reason','ticket_reference','row_snapshot','detail'])
  OR ROW(NEW.reason,NEW.ticket_reference,NEW.row_snapshot,NEW.detail) IS DISTINCT FROM ROW(OLD.reason,OLD.ticket_reference,OLD.row_snapshot,OLD.detail)
   AND NOT (coalesce(NEW.row_snapshot @> '{"erased":true}'::jsonb,false) AND coalesce(NEW.detail @> '{"erased":true}'::jsonb,false) AND NEW.scope_held) THEN
  RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_native_memory_retraction_receipt() FROM PUBLIC;
CREATE TRIGGER native_memory_retraction_receipt BEFORE INSERT OR UPDATE OR DELETE ON correction_audit
 FOR EACH ROW EXECUTE FUNCTION guard_native_memory_retraction_receipt();

CREATE FUNCTION retract_admitted_native_memory(w uuid,i uuid,v text,acting uuid,session uuid,context_hash text,reason text,at_time timestamptz) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE old memories;new_version text;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 context jsonb;source jsonb;policy jsonb;mask jsonb;roots jsonb;receipt uuid;
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
 -- Keep the ordinary semantic version advance and descendant invalidation.
 UPDATE memories SET retracted_at=at_time,retracted_reason=reason,retracted_by=actor,valid_to=COALESCE(valid_to,at_time)
  WHERE workspace_id=w AND id=i AND scope_version::text=v AND valid_to IS NULL AND retracted_at IS NULL
  RETURNING scope_version::text INTO new_version;
 IF NOT FOUND OR new_version IS DISTINCT FROM (old.scope_version+1)::text THEN
  RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='40001';END IF;
 -- Insert after the factual invalidation; this is a receipt of that operation,
 -- not a new live derivation of the withdrawn fact or a retained old body.
 INSERT INTO correction_audit(workspace_id,action,primitive,row_id,actor_user_id,reason,native_memory_transition)
 VALUES(w,'retract','memory',i,actor,reason,jsonb_build_object('kind','native_memory_retract_v1',
  'priorVersion',v,'resultVersion',new_version,'actorId',actor,'assistantId',acting,'sessionId',session,
  'contextFingerprint',context_hash,'writeFields',fields,'originalRoots',roots,'transactionId',pg_current_xact_id()::text))
 RETURNING id INTO receipt;
 RETURN receipt;
END $$;
REVOKE ALL ON FUNCTION retract_admitted_native_memory(uuid,uuid,text,uuid,uuid,text,text,timestamptz) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 REVOKE ALL ON FUNCTION guard_native_memory_retraction_receipt() FROM app_user;
 GRANT EXECUTE ON FUNCTION retract_admitted_native_memory(uuid,uuid,text,uuid,uuid,text,text,timestamptz) TO app_user;
END IF;END $$;
COMMIT;
