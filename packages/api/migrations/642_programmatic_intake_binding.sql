BEGIN;
ALTER TABLE programmatic_capture_profiles ADD COLUMN intake_binding jsonb;
ALTER TABLE brain_keys ADD COLUMN capture_intake_revision bigint NOT NULL DEFAULT 1;
CREATE FUNCTION version_programmatic_key_binding() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.workspace_id,NEW.status,NEW.scope,NEW.max_clearance,NEW.capture_assistant_id,NEW.capture_profile_id,NEW.context_group_id,NEW.context_project_id,NEW.context_binding_origin)
 IS DISTINCT FROM ROW(OLD.workspace_id,OLD.status,OLD.scope,OLD.max_clearance,OLD.capture_assistant_id,OLD.capture_profile_id,OLD.context_group_id,OLD.context_project_id,OLD.context_binding_origin)
 THEN NEW.capture_intake_revision:=OLD.capture_intake_revision+1;
 ELSE NEW.capture_intake_revision:=OLD.capture_intake_revision; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER programmatic_key_binding_version BEFORE UPDATE ON brain_keys FOR EACH ROW EXECUTE FUNCTION version_programmatic_key_binding();

-- This metadata-only proof is callable under the application role. It never
-- returns session or intake contents. The workspace is locked by the caller.
CREATE FUNCTION programmatic_configuration_actor(w uuid, actor uuid, session uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT actor = nullif(current_setting('app.current_user_id',true),'')::uuid
 AND EXISTS(SELECT 1 FROM workspace_members m JOIN users u ON u.id=m.user_id
 JOIN auth_sessions s ON s.user_id=u.id AND s.id=session
 WHERE m.workspace_id=w AND m.user_id=actor AND m.role IN ('owner','admin')
 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.auth_version=u.auth_version)
$$;

CREATE FUNCTION guard_programmatic_intake_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b jsonb; ready boolean;
BEGIN
 PERFORM 1 FROM workspaces WHERE id=NEW.workspace_id FOR UPDATE NOWAIT;
 SELECT setup_state='ready' INTO ready FROM workspace_access_policies WHERE workspace_id=NEW.workspace_id;
 IF TG_OP='UPDATE' THEN
  IF NEW.intake_binding IS DISTINCT FROM OLD.intake_binding OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
   THEN RAISE EXCEPTION 'capture_binding_immutable'; END IF;
  IF OLD.intake_binding IS NOT NULL AND NOT programmatic_configuration_actor(NEW.workspace_id,
    nullif(current_setting('app.current_user_id',true),'')::uuid,
    nullif(current_setting('app.capture_session',true),'')::uuid) THEN RAISE EXCEPTION 'capture_configuration_denied'; END IF;
  RETURN NEW;
 END IF;
 b:=NEW.intake_binding;
 IF b IS NULL THEN
  IF ready THEN RAISE EXCEPTION 'capture_configuration_required'; END IF;
  RETURN NEW;
 END IF;
 IF b IS DISTINCT FROM nullif(current_setting('app.capture_admission',true),'')::jsonb
 OR NOT ready OR programmatic_configuration_actor(NEW.workspace_id,(b->>'actor')::uuid,(b->>'session')::uuid) IS NOT TRUE
  OR b->>'policyRevision' IS DISTINCT FROM (SELECT revision::text FROM workspace_access_policies WHERE workspace_id=NEW.workspace_id)
  OR b->>'sensitivity' NOT IN ('public','internal','confidential')
  OR jsonb_typeof(b->'compartments') IS DISTINCT FROM 'array' OR jsonb_typeof(b->'projectIds') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'capture_configuration_denied'; END IF;
 PERFORM set_config('app.capture_admission','',true);
 RETURN NEW;
END $$;
CREATE TRIGGER programmatic_intake_binding_guard BEFORE INSERT OR UPDATE ON programmatic_capture_profiles
 FOR EACH ROW EXECUTE FUNCTION guard_programmatic_intake_binding();

CREATE FUNCTION guard_programmatic_rule_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p programmatic_capture_profiles;
BEGIN
 IF NEW.capture_profile_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO p FROM programmatic_capture_profiles WHERE id=NEW.capture_profile_id;
 PERFORM 1 FROM workspaces WHERE id=p.workspace_id FOR UPDATE NOWAIT;
 IF p.intake_binding IS NULL THEN
  IF EXISTS(SELECT 1 FROM workspace_access_policies WHERE workspace_id=p.workspace_id AND setup_state='ready')
   THEN RAISE EXCEPTION 'capture_configuration_required'; END IF;
  RETURN NEW;
 END IF;
 IF programmatic_configuration_actor(p.workspace_id,nullif(current_setting('app.current_user_id',true),'')::uuid,
    nullif(current_setting('app.capture_session',true),'')::uuid) IS NOT TRUE THEN RAISE EXCEPTION 'capture_configuration_denied'; END IF;
 IF NEW.routing_mode NOT IN ('scheduled','drop') THEN RAISE EXCEPTION 'capture_ready_scheduled_required'; END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.capture_profile_id,NEW.compartments,NEW.project_ids,NEW.episode_sensitivity,NEW.scope_binding_mode,NEW.scope_binding_origin)
 IS DISTINCT FROM ROW(OLD.capture_profile_id,OLD.compartments,OLD.project_ids,OLD.episode_sensitivity,OLD.scope_binding_mode,OLD.scope_binding_origin)
 THEN RAISE EXCEPTION 'capture_binding_immutable'; END IF;
 IF NEW.compartments IS DISTINCT FROM ARRAY(SELECT jsonb_array_elements_text(p.intake_binding->'compartments'))
 OR NEW.project_ids IS DISTINCT FROM ARRAY(SELECT jsonb_array_elements_text(p.intake_binding->'projectIds')::uuid)
 OR NEW.episode_sensitivity IS DISTINCT FROM p.intake_binding->>'sensitivity'
 OR NEW.scope_binding_mode<>'explicit' OR NEW.scope_binding_origin NOT IN ('explicit','reviewed')
 THEN RAISE EXCEPTION 'capture_binding_mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER programmatic_rule_binding_guard BEFORE INSERT OR UPDATE ON ingest_rules
 FOR EACH ROW EXECUTE FUNCTION guard_programmatic_rule_binding();

-- Current exact key, destination, configuration session, and member authority.
-- Unsupported principal kinds are deliberately not admitted in ready mode.
CREATE FUNCTION programmatic_intake_current(w uuid, a uuid, r uuid, ev jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p programmatic_capture_profiles; rule ingest_rules; b jsonb; k brain_keys; reach text[];
BEGIN
 SELECT * INTO rule FROM ingest_rules WHERE id=r AND source='programmatic';
 SELECT * INTO p FROM programmatic_capture_profiles WHERE id=rule.capture_profile_id AND workspace_id=w AND enabled;
 IF p.id IS NULL OR rule.scope_binding_origin='held' THEN RETURN false; END IF;
 b:=p.intake_binding;
 IF b IS NULL THEN RETURN NOT EXISTS(SELECT 1 FROM workspace_access_policies WHERE workspace_id=w AND setup_state='ready'); END IF;
 IF ev->>'principalKind'<>'api_key' THEN RETURN false; END IF;
 PERFORM 1 FROM assistants WHERE id=a AND workspace_id=w FOR SHARE;
 SELECT * INTO k FROM brain_keys WHERE id=(ev->>'principalId')::uuid AND workspace_id=w AND status='active' AND scope='read_write' AND context_binding_origin IN ('explicit','reviewed') FOR SHARE;
 IF k.id IS NULL
 OR (ev ? 'producerBinding' AND ev->'producerBinding' IS DISTINCT FROM jsonb_build_object('keyRevision',k.capture_intake_revision::text,'profileId',p.id::text,'ruleId',r::text,'assistantId',a::text))
 OR (k.context_group_id IS NOT NULL AND b->'compartments' IS DISTINCT FROM (SELECT jsonb_build_array(compartment_key) FROM workspace_groups WHERE id=k.context_group_id AND workspace_id=w AND status='active'))
 OR (k.context_project_id IS NOT NULL AND b->'projectIds' IS DISTINCT FROM jsonb_build_array(k.context_project_id::text))
 OR k.capture_assistant_id IS DISTINCT FROM a
 OR coalesce(k.capture_profile_id,(SELECT capture_profile_id FROM assistants WHERE id=a AND workspace_id=w)) IS DISTINCT FROM p.id
 OR NOT EXISTS(SELECT 1 FROM assistants WHERE id=a AND workspace_id=w AND context_binding_origin<>'held'
   AND (clearance='confidential' OR clearance=b->>'sensitivity' OR (clearance='internal' AND b->>'sensitivity'='public')))
 OR (k.max_clearance IS NOT NULL AND k.max_clearance<>'confidential' AND k.max_clearance<>b->>'sensitivity'
   AND NOT(k.max_clearance='internal' AND b->>'sensitivity'='public'))
 THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM auth_sessions s JOIN users u ON u.id=s.user_id JOIN workspace_members m ON m.user_id=u.id
 WHERE s.id=(b->>'session')::uuid AND u.id=(b->>'actor')::uuid AND m.workspace_id=w AND m.role IN ('owner','admin')
 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.auth_version=u.auth_version FOR SHARE OF s,u,m) THEN RETURN false; END IF;
 reach:=effective_member_team_compartments((b->>'actor')::uuid,w);
 IF reach IS NOT NULL AND NOT ARRAY(SELECT jsonb_array_elements_text(b->'compartments')) <@ reach THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(b->'compartments') x WHERE NOT EXISTS(
 SELECT 1 FROM workspace_groups g WHERE g.workspace_id=w AND g.compartment_key=x AND g.kind='team' AND g.status='active'))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(b->'projectIds') x WHERE NOT EXISTS(
 SELECT 1 FROM workspace_projects pr WHERE pr.workspace_id=w AND pr.id=x::uuid AND pr.status='active')) THEN RETURN false; END IF;
 RETURN true;
END $$;

CREATE FUNCTION guard_programmatic_batch_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b jsonb; ev jsonb; pinned jsonb:='[]'::jsonb; profile uuid;
BEGIN
 IF TG_OP='UPDATE' AND OLD.source='programmatic' AND NEW.source IS DISTINCT FROM OLD.source THEN RAISE EXCEPTION 'capture_binding_immutable'; END IF;
 IF NEW.source<>'programmatic' THEN RETURN NEW; END IF;
 PERFORM 1 FROM workspaces WHERE id=NEW.workspace_id FOR UPDATE NOWAIT;
 IF TG_OP='UPDATE' AND ROW(NEW.workspace_id,NEW.rule_id,NEW.assistant_id,NEW.source,NEW.compartments,NEW.project_ids,NEW.episode_sensitivity)
 IS DISTINCT FROM ROW(OLD.workspace_id,OLD.rule_id,OLD.assistant_id,OLD.source,OLD.compartments,OLD.project_ids,OLD.episode_sensitivity) THEN RAISE EXCEPTION 'capture_binding_immutable'; END IF;
 IF TG_OP='UPDATE' AND OLD.processed_at IS NOT NULL AND (NEW.events IS DISTINCT FROM OLD.events OR NEW.processed_at IS DISTINCT FROM OLD.processed_at) THEN RAISE EXCEPTION 'capture_binding_immutable'; END IF;
 IF TG_OP='UPDATE' AND OLD.scope_held AND NOT NEW.scope_held THEN RAISE EXCEPTION 'capture_binding_held'; END IF;
 SELECT p.intake_binding,p.id INTO b,profile FROM ingest_rules r JOIN programmatic_capture_profiles p ON p.id=r.capture_profile_id
 WHERE r.id=NEW.rule_id AND p.workspace_id=NEW.workspace_id;
 IF b IS NULL AND NOT EXISTS(SELECT 1 FROM workspace_access_policies WHERE workspace_id=NEW.workspace_id AND setup_state='ready') THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND NEW.scope_held AND NEW.events IS NOT DISTINCT FROM OLD.events THEN RETURN NEW; END IF;
 IF b IS NULL OR NEW.scope_held OR NEW.scope_binding_origin NOT IN ('explicit','reviewed')
 OR NEW.compartments IS DISTINCT FROM ARRAY(SELECT jsonb_array_elements_text(b->'compartments'))
 OR NEW.project_ids IS DISTINCT FROM ARRAY(SELECT jsonb_array_elements_text(b->'projectIds')::uuid)
 OR NEW.episode_sensitivity IS DISTINCT FROM b->>'sensitivity' THEN RAISE EXCEPTION 'capture_binding_unavailable'; END IF;
 IF TG_OP='UPDATE' AND (jsonb_array_length(NEW.events)<jsonb_array_length(OLD.events)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(OLD.events) WITH ORDINALITY x(value,n) WHERE NEW.events->(x.n::int-1) IS DISTINCT FROM x.value))
 THEN RAISE EXCEPTION 'capture_payload_immutable'; END IF;
 FOR ev IN SELECT value FROM jsonb_array_elements(NEW.events) LOOP
  IF programmatic_intake_current(NEW.workspace_id,NEW.assistant_id,NEW.rule_id,ev) IS NOT TRUE
  THEN RAISE EXCEPTION 'capture_binding_unavailable'; END IF;
  IF NOT ev ? 'producerBinding' THEN
   ev:=ev||jsonb_build_object('producerBinding',jsonb_build_object('keyRevision',
    (SELECT capture_intake_revision::text FROM brain_keys WHERE id=(ev->>'principalId')::uuid),
    'profileId',profile::text,'ruleId',NEW.rule_id::text,'assistantId',NEW.assistant_id::text));
  END IF;
  pinned:=pinned||jsonb_build_array(ev);
 END LOOP;
 NEW.events:=pinned;
 RETURN NEW;
END $$;
CREATE TRIGGER programmatic_batch_binding_guard BEFORE INSERT OR UPDATE ON pending_ingest_batches
 FOR EACH ROW EXECUTE FUNCTION guard_programmatic_batch_binding();
-- Resolve programmatic scope from its canonical profile, while retaining all
-- existing connector workspace/Team/Project checks (no trigger exemptions).
CREATE OR REPLACE FUNCTION public.validate_connector_context_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  workspace_value uuid;
  compartment_values text[];
  project_values uuid[];
BEGIN
  IF TG_TABLE_NAME = 'connector_instance' THEN
    workspace_value := NEW.workspace_id;
  ELSIF TG_TABLE_NAME = 'connector_grant' THEN
    IF NEW.target_type <> 'workspace' THEN
      RAISE EXCEPTION 'context-bound connector grants require a workspace target';
    END IF;
    workspace_value := NEW.target_id;
  ELSE
    IF NEW.capture_profile_id IS NOT NULL THEN
      SELECT workspace_id INTO workspace_value FROM programmatic_capture_profiles WHERE id=NEW.capture_profile_id;
    ELSE
    SELECT CASE
      WHEN ci.scope = 'workspace' THEN ci.workspace_id
      ELSE (
        SELECT cg.target_id FROM public.connector_grant cg
         WHERE cg.connector_instance_id = ci.id
           AND cg.target_type = 'workspace'
         ORDER BY cg.granted_at
         LIMIT 1
      )
    END INTO workspace_value
    FROM public.connector_instance ci
    WHERE ci.id = NEW.connector_instance_id;
    END IF;
  END IF;

  compartment_values := COALESCE(NEW.compartments, ARRAY[]::text[]);
  project_values := COALESCE(NEW.project_ids, ARRAY[]::uuid[]);
  IF workspace_value IS NULL
     AND (cardinality(compartment_values) > 0 OR cardinality(project_values) > 0) THEN
    RAISE EXCEPTION 'scoped connector surfaces require a workspace';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(compartment_values) key
     WHERE key LIKE 'team:%'
       AND NOT EXISTS (
         SELECT 1 FROM public.workspace_compartments wc
          WHERE wc.workspace_id = workspace_value
            AND wc.key = key
            AND wc.managed_by = 'team'
       )
  ) THEN
    RAISE EXCEPTION 'connector Team requirements must stay within one workspace';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(project_values) project_id
     WHERE NOT EXISTS (
       SELECT 1 FROM public.workspace_projects p
        WHERE p.id = project_id AND p.workspace_id = workspace_value
     )
  ) THEN
    RAISE EXCEPTION 'connector Project requirements must stay within one workspace';
  END IF;
  RETURN NEW;
END;
$$;
ALTER TABLE episodes ADD COLUMN programmatic_batch_id uuid UNIQUE REFERENCES pending_ingest_batches(id);
CREATE OR REPLACE FUNCTION public.require_workspace_creation_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE policy public.workspace_access_policies; receipt jsonb; body jsonb; actor uuid;
  actual_compartments jsonb; actual_projects jsonb; expected_projects jsonb;
BEGIN
  PERFORM 1 FROM public.workspaces WHERE id=NEW.workspace_id FOR UPDATE;
  SELECT * INTO policy FROM public.workspace_access_policies WHERE workspace_id=NEW.workspace_id;
  body:=to_jsonb(NEW);
  IF TG_ARGV[0]='episode' AND body->>'programmatic_batch_id' IS NOT NULL THEN
    IF body->>'programmatic_batch_id' IS DISTINCT FROM nullif(current_setting('app.programmatic_publication_batch',true),'')
    OR NOT EXISTS(SELECT 1 FROM public.pending_ingest_batches b
      JOIN public.ingest_rules r ON r.id=b.rule_id
      JOIN public.programmatic_capture_profiles p ON p.id=r.capture_profile_id
      WHERE b.id=(body->>'programmatic_batch_id')::uuid AND b.workspace_id=NEW.workspace_id
      AND b.source='programmatic' AND b.processed_at IS NULL AND NOT b.scope_held
      AND p.intake_binding IS NOT NULL AND body->>'user_id' IS NULL
      AND body->>'assistant_id'=b.assistant_id::text
      AND body->>'created_by_user_id'=p.intake_binding->>'actor'
      AND body->>'created_by_assistant_id'=b.assistant_id::text
      AND body->>'sensitivity'=b.episode_sensitivity
      AND body->'compartments'=to_jsonb(b.compartments) AND body->'project_ids'=to_jsonb(b.project_ids)
      AND body->'source_ref'->>'batch_id'=b.id::text
      AND body->'source_ref'->>'profile_id'=p.id::text AND body->'source_ref'->>'rule_id'=r.id::text
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b.events) ev
        WHERE public.programmatic_intake_current(b.workspace_id,b.assistant_id,b.rule_id,ev) IS NOT TRUE))
      THEN RAISE EXCEPTION 'capture_binding_unavailable' USING ERRCODE='42501'; END IF;
    PERFORM set_config('app.programmatic_publication_batch','',true);
    RETURN NEW;
  END IF;
  IF nullif(current_setting('app.programmatic_candidate',true),'') IS NOT NULL THEN
    receipt:=current_setting('app.programmatic_candidate')::jsonb;
    actual_compartments:=programmatic_candidate_source();
    PERFORM set_config('app.programmatic_candidate','',true);
    IF TG_ARGV[0] IS DISTINCT FROM receipt->>'kind'
    OR body->>'source_episode_id' IS DISTINCT FROM receipt->'source'->>'resourceId'
    OR body->>'created_by_user_id' IS DISTINCT FROM receipt->>'actor'
    OR body->>'created_by_assistant_id' IS DISTINCT FROM actual_compartments->>'assistantId'
    OR body->>'source'<>'extracted' OR body->>'source_session_id' IS NOT NULL
    OR body->>'workspace_id' IS DISTINCT FROM actual_compartments->>'workspaceId'
    OR body->>'user_id' IS DISTINCT FROM actual_compartments->>'userId'
    OR body->>'assistant_id' IS DISTINCT FROM actual_compartments->>'assistantId'
    OR body->>'sensitivity' IS DISTINCT FROM actual_compartments->>'sensitivity'
    OR body->'compartments' IS DISTINCT FROM actual_compartments->'compartments'
    OR body->'project_ids' IS DISTINCT FROM actual_compartments->'projectIds'
    THEN RAISE EXCEPTION 'capture_candidate_scope_mismatch'; END IF;
    RETURN NEW;
  END IF;
  IF policy.workspace_id IS NULL OR policy.setup_state='legacy' THEN RETURN NEW; END IF;
  BEGIN
    receipt:=nullif(current_setting('app.creation_admission',true),'')::jsonb;
    actor:=(receipt->>'actor')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'workspace_creation_admission_required' USING ERRCODE='42501';
  END;
  -- Consume exactly once; a batch/secondary insert needs its own admission.
  PERFORM set_config('app.creation_admission','',true);
  body:=to_jsonb(NEW);
  SELECT coalesce(jsonb_agg(value ORDER BY value),'[]'::jsonb) INTO actual_compartments
    FROM (SELECT DISTINCT value FROM jsonb_array_elements(body->'compartments')) keys;
  SELECT coalesce(jsonb_agg(value ORDER BY value),'[]'::jsonb) INTO actual_projects
    FROM (SELECT DISTINCT lower(value) AS value FROM jsonb_array_elements_text(body->'project_ids')) ids;
  SELECT coalesce(jsonb_agg(value ORDER BY value),'[]'::jsonb) INTO expected_projects
    FROM (SELECT DISTINCT lower(value) AS value FROM jsonb_array_elements_text(receipt->'envelope'->'projectIds')) ids;
  IF receipt IS NULL OR receipt->>'protocol' IS DISTINCT FROM '1'
    OR receipt->>'kind' IS DISTINCT FROM TG_ARGV[0]
    OR receipt->>'workspaceId' IS DISTINCT FROM NEW.workspace_id::text
    OR receipt->>'policyRevision' IS DISTINCT FROM policy.revision::text
    OR actor IS NULL OR NOT EXISTS(SELECT 1 FROM public.workspace_members WHERE workspace_id=NEW.workspace_id AND user_id=actor)
    -- Authorship can legitimately survive supersession by another authorized
    -- actor. Compare the executing RLS identity, not historical created_by.
    OR (nullif(current_setting('app.current_user_id',true),'') IS NOT NULL
      AND nullif(current_setting('app.current_user_id',true),'')::uuid IS DISTINCT FROM actor)
    OR receipt->'rowVisibility'->>'userId' IS DISTINCT FROM body->>'user_id'
    OR receipt->'rowVisibility'->>'assistantId' IS DISTINCT FROM body->>'assistant_id'
    OR receipt->'envelope'->>'visibility' IS DISTINCT FROM (CASE WHEN body->>'user_id' IS NULL THEN 'workspace' ELSE 'private' END)
    OR receipt->'envelope'->>'sensitivity' IS DISTINCT FROM body->>'sensitivity'
    OR receipt->'envelope'->'compartments' IS DISTINCT FROM actual_compartments
    OR expected_projects IS DISTINCT FROM actual_projects
  THEN RAISE EXCEPTION 'workspace_creation_admission_required' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION guard_programmatic_episode_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.programmatic_batch_id IS DISTINCT FROM OLD.programmatic_batch_id
 OR (OLD.programmatic_batch_id IS NOT NULL AND ROW(NEW.workspace_id,NEW.user_id,NEW.assistant_id,NEW.source_ref,NEW.content_ref,NEW.compartments,NEW.project_ids,NEW.sensitivity)
 IS DISTINCT FROM ROW(OLD.workspace_id,OLD.user_id,OLD.assistant_id,OLD.source_ref,OLD.content_ref,OLD.compartments,OLD.project_ids,OLD.sensitivity))
 THEN RAISE EXCEPTION 'capture_source_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER programmatic_episode_source_guard BEFORE UPDATE ON episodes FOR EACH ROW EXECUTE FUNCTION guard_programmatic_episode_source();
CREATE FUNCTION check_programmatic_publication_commit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE batch pending_ingest_batches; ev jsonb;
BEGIN
 IF TG_TABLE_NAME='episodes' THEN
  IF NEW.programmatic_batch_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO batch FROM pending_ingest_batches WHERE id=NEW.programmatic_batch_id;
 ELSE
  IF NEW.source<>'programmatic' OR NEW.processed_at IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO batch FROM pending_ingest_batches WHERE id=NEW.id;
  IF NOT EXISTS(SELECT 1 FROM ingest_rules r JOIN programmatic_capture_profiles p ON p.id=r.capture_profile_id WHERE r.id=batch.rule_id AND p.intake_binding IS NOT NULL) THEN RETURN NULL; END IF;
 END IF;
 IF batch.id IS NULL OR batch.scope_held OR batch.processed_at IS NULL
 OR NOT EXISTS(SELECT 1 FROM episodes e JOIN episode_extraction_runs r ON r.episode_id=e.id
  WHERE e.programmatic_batch_id=batch.id AND e.workspace_id=batch.workspace_id
  AND e.status='archived' AND NOT e.scope_held AND NOT e.extraction_locked
  AND r.application_state='complete' AND r.extraction_state='succeeded' AND NOT r.scope_held
  AND r.source_scope_version=e.scope_version
  AND jsonb_array_length(r.frozen_plan->'candidates')>0
  AND jsonb_array_length(r.frozen_plan->'candidates')=(SELECT count(*) FROM episode_extraction_items i WHERE i.run_id=r.id)
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.frozen_plan->'candidates') candidate
    WHERE NOT EXISTS(SELECT 1 FROM episode_extraction_items i WHERE i.run_id=r.id
      AND i.candidate_id=candidate->>'candidateId' AND i.payload_hash=candidate->>'payloadHash'
      AND i.primitive_kind=candidate->>'primitiveKind' AND i.disposition='committed'
      AND i.receipt_id IS NOT NULL AND i.target_record_id IS NOT NULL)))
 THEN RAISE EXCEPTION 'capture_publication_incomplete'; END IF;
 FOR ev IN SELECT value FROM jsonb_array_elements(batch.events) LOOP
  IF NOT ev ? 'producerBinding' OR programmatic_intake_current(batch.workspace_id,batch.assistant_id,batch.rule_id,ev) IS NOT TRUE
  THEN RAISE EXCEPTION 'capture_binding_unavailable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM programmatic_capture_receipts receipt WHERE receipt.batch_id=batch.id
    AND receipt.workspace_id=batch.workspace_id AND receipt.rule_id=batch.rule_id AND receipt.status='completed'
    AND receipt.principal_kind=ev->>'principalKind' AND receipt.principal_id=(ev->>'principalId')::uuid
    AND receipt.event_id=ev->>'eventId') THEN RAISE EXCEPTION 'capture_publication_incomplete'; END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER programmatic_episode_commit AFTER INSERT ON episodes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_programmatic_publication_commit();
CREATE CONSTRAINT TRIGGER programmatic_batch_commit AFTER UPDATE ON pending_ingest_batches DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_programmatic_publication_commit();

CREATE FUNCTION programmatic_candidate_source() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE proof jsonb:=nullif(current_setting('app.programmatic_candidate_source',true),'')::jsonb; expected jsonb; actual jsonb; ep episodes; batch pending_ingest_batches; binding jsonb; ev jsonb;
BEGIN
 IF proof IS NULL THEN RETURN NULL; END IF;
 expected:=proof->'source';
 IF proof->>'kind' NOT IN ('memory','entity','task') OR expected->>'resourceKind'<>'episode' THEN RAISE EXCEPTION 'capture_source_changed'; END IF;
 PERFORM 1 FROM workspaces WHERE id=(expected->>'workspaceId')::uuid FOR UPDATE;
 SELECT * INTO batch FROM pending_ingest_batches WHERE id=(proof->>'batchId')::uuid AND workspace_id=(expected->>'workspaceId')::uuid FOR SHARE;
 SELECT * INTO ep FROM episodes WHERE id=(expected->>'resourceId')::uuid AND programmatic_batch_id=batch.id AND workspace_id=batch.workspace_id FOR SHARE;
 SELECT p.intake_binding INTO binding FROM ingest_rules r JOIN programmatic_capture_profiles p ON p.id=r.capture_profile_id WHERE r.id=batch.rule_id;
 IF batch.id IS NULL OR batch.processed_at IS NOT NULL OR batch.scope_held OR ep.id IS NULL OR ep.scope_held OR ep.extraction_locked OR ep.status<>'archived'
 OR binding->>'actor' IS DISTINCT FROM proof->>'actor' THEN RAISE EXCEPTION 'capture_source_changed'; END IF;
 FOR ev IN SELECT value FROM jsonb_array_elements(batch.events) LOOP
  IF NOT ev ? 'producerBinding' OR programmatic_intake_current(batch.workspace_id,batch.assistant_id,batch.rule_id,ev) IS NOT TRUE THEN RAISE EXCEPTION 'capture_binding_unavailable'; END IF;
 END LOOP;
 actual:=read_scope_source(ep.workspace_id,'episode',ep.id);
 IF actual->>'version' IS DISTINCT FROM expected->>'version' OR actual->>'workspaceId' IS DISTINCT FROM expected->>'workspaceId'
 OR actual->>'userId' IS DISTINCT FROM expected->>'userId' OR actual->>'assistantId' IS DISTINCT FROM expected->>'assistantId'
 OR actual->>'sensitivity' IS DISTINCT FROM expected->>'sensitivity' OR actual->'compartments' IS DISTINCT FROM expected->'compartments'
 OR actual->'projectIds' IS DISTINCT FROM expected->'projectIds' THEN RAISE EXCEPTION 'capture_source_changed'; END IF;
 RETURN actual;
END $$;
ALTER FUNCTION read_entity_derivation_source(uuid,text,uuid) RENAME TO read_entity_derivation_source_before_capture;
CREATE FUNCTION read_entity_derivation_source(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s jsonb;
BEGIN
 IF nullif(current_setting('app.programmatic_candidate_source',true),'') IS NULL THEN RETURN read_entity_derivation_source_before_capture(w,k,i); END IF;
 s:=programmatic_candidate_source();
 IF w::text IS DISTINCT FROM s->>'workspaceId' OR k<>'episode' OR i::text IS DISTINCT FROM (nullif(current_setting('app.programmatic_candidate_source',true),'')::jsonb)->'source'->>'resourceId' THEN RAISE EXCEPTION 'capture_source_changed'; END IF;
 RETURN s;
END $$;
ALTER FUNCTION create_source_derived_entity(jsonb,jsonb) RENAME TO create_source_derived_entity_before_capture;
CREATE FUNCTION create_source_derived_entity(p jsonb,e jsonb) RETURNS SETOF entities
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE proof jsonb:=nullif(current_setting('app.programmatic_candidate_source',true),'')::jsonb; s jsonb; output entities; d uuid;
BEGIN
 IF proof IS NULL THEN RETURN QUERY SELECT * FROM create_source_derived_entity_before_capture(p,e); RETURN; END IF;
 s:=programmatic_candidate_source();
 IF proof->>'kind'<>'entity' OR e->>'producer'<>'programmatic-capture' OR e->'sources' IS DISTINCT FROM jsonb_build_array(proof->'source')
 OR p->>'sourceEpisodeId' IS DISTINCT FROM proof->'source'->>'resourceId' OR p->>'createdByUserId' IS DISTINCT FROM proof->>'actor'
 OR p->>'sourceSessionId' IS NOT NULL OR p->>'source'<>'extracted' THEN RAISE EXCEPTION 'capture_source_changed'; END IF;
 INSERT INTO entities(kind,display_name,canonical_id,aliases,attributes,sensitivity,workspace_id,user_id,assistant_id,
 created_by_user_id,created_by_assistant_id,source_episode_id,source,compartments,project_ids)
 VALUES(p->>'kind',p->>'displayName',p->>'canonicalId',ARRAY(SELECT jsonb_array_elements_text(p->'aliases')),coalesce(p->'attributes','{}'),
 p->>'sensitivity',(p->>'workspaceId')::uuid,(p->>'userId')::uuid,(p->>'assistantId')::uuid,(p->>'createdByUserId')::uuid,
 (p->>'createdByAssistantId')::uuid,(p->>'sourceEpisodeId')::uuid,p->>'source',ARRAY(SELECT jsonb_array_elements_text(p->'compartments')),ARRAY(SELECT jsonb_array_elements_text(p->'projectIds')::uuid)) RETURNING * INTO output;
 INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
 SELECT output.workspace_id,'entity',output.id,output.scope_version::text,e->>'producer',output.user_id,output.assistant_id,output.sensitivity,output.compartments,output.project_ids,revision FROM workspace_access_policies WHERE workspace_id=output.workspace_id RETURNING id INTO d;
 INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
 VALUES(output.workspace_id,d,'episode',(proof->'source'->>'resourceId')::uuid,proof->'source'->>'version');
 RETURN NEXT output;
END $$;
ALTER TABLE scope_derivations DROP CONSTRAINT scope_derivations_resource_kind_check;
ALTER TABLE scope_derivations ADD CONSTRAINT scope_derivations_resource_kind_check CHECK(resource_kind IN ('memory','session_message','feedback_event','workspace_skill_revision','entity','entity_link','knowledge_entry','workspace_file','task'));
CREATE FUNCTION hold_programmatic_candidate_outputs() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.programmatic_batch_id IS NOT NULL AND (NEW.scope_held OR NEW.extraction_locked OR NEW.scope_version IS DISTINCT FROM OLD.scope_version) THEN
  UPDATE memories SET scope_held=true WHERE source_episode_id=OLD.id AND NOT scope_held;
  UPDATE entities SET scope_held=true WHERE source_episode_id=OLD.id AND NOT scope_held;
  UPDATE tasks SET scope_held=true WHERE source_episode_id=OLD.id AND NOT scope_held;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER programmatic_candidate_output_hold AFTER UPDATE ON episodes FOR EACH ROW EXECUTE FUNCTION hold_programmatic_candidate_outputs();
COMMIT;
