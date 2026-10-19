BEGIN;
-- [COMP:api/application-governance]
CREATE TABLE application_native_governance_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 module_key text NOT NULL REFERENCES application_native_field_contracts(module_key),
 actor_user_id uuid NOT NULL REFERENCES users(id),
 assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
 proposal jsonb NOT NULL CHECK(jsonb_typeof(proposal)='object'),
 reviewed_revision text NOT NULL CHECK(reviewed_revision ~ '^[0-9a-f]{64}$'),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 applied_revision text CHECK(applied_revision ~ '^[0-9a-f]{64}$'),
 outcome jsonb CHECK(outcome IS NULL OR jsonb_typeof(outcome)='object')
);
CREATE TABLE application_native_governance_events (
 review_id uuid PRIMARY KEY REFERENCES application_native_governance_reviews(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 module_key text NOT NULL,actor_user_id uuid NOT NULL REFERENCES users(id),
 operation_kind text NOT NULL,resource_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE application_native_governance_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_native_governance_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON application_native_governance_reviews,application_native_governance_events FROM PUBLIC;

CREATE FUNCTION application_native_governance_review_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['applied_revision','outcome']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['applied_revision','outcome'])
  OR OLD.outcome IS NOT NULL OR NEW.outcome IS NULL OR NEW.applied_revision IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_class c ON c.oid='public.application_native_governance_reviews'::regclass
   WHERE r.rolname=current_user AND c.relowner=r.oid) THEN
  RAISE EXCEPTION 'invalid_value: immutable governance review' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION application_native_governance_review_guard() FROM PUBLIC;
CREATE TRIGGER application_native_governance_review_guard BEFORE UPDATE ON application_native_governance_reviews
 FOR EACH ROW EXECUTE FUNCTION application_native_governance_review_guard();

-- Metadata only: actual native actor, deployed policy, and complete current
-- protected schema/record/reference governance. No membership or field grants.
CREATE FUNCTION application_native_module_governance_allows(w uuid,module text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE owned public.application_native_resource_owners; actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR public.application_governance_allows(w) IS NOT TRUE
  OR public.application_native_configuration_verified(w,module) IS NOT TRUE
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_class c ON c.oid='public.application_native_field_contracts'::regclass
   WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN false; END IF;
 -- Hold current native membership and explicit role rows for the operation.
 PERFORM 1 FROM public.workspace_members m WHERE m.workspace_id=w AND m.user_id=actor AND m.role IN('owner','admin') FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM 1 FROM public.application_native_role_assignments a WHERE a.workspace_id=w AND a.module_key=module AND a.user_id=actor
  AND a.status='active' AND a.starts_at<=statement_timestamp() AND (a.expires_at IS NULL OR a.expires_at>statement_timestamp()) FOR SHARE;
 FOR owned IN SELECT o.* FROM public.application_native_resource_owners o WHERE o.workspace_id=w AND o.module_key=module
   ORDER BY o.resource_type,o.origin::text FOR SHARE LOOP
  IF owned.origin->>'kind'<>'generic' OR public.application_native_schema_governance_allows(w,(owned.origin->>'entityTypeId')::uuid) IS NOT TRUE THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_native_module_governance_allows(uuid,text) FROM PUBLIC;

CREATE FUNCTION application_native_governance_revision(w uuid,acting uuid,module text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid; epoch jsonb;
BEGIN
 IF public.application_native_module_governance_allows(w,module) IS NOT TRUE OR acting IS NULL
  OR public.assistant_placement_visible(actor,acting) IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM public.assistants a WHERE a.id=acting AND a.workspace_id=w)
  OR nullif(current_setting('app.v2_assistant_id',true),'') IS NOT NULL AND current_setting('app.v2_assistant_id',true)::uuid<>acting THEN
  RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 epoch:=public.read_application_policy_epoch(w,actor,acting);
 IF epoch IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 RETURN public.application_field_digest(epoch);
END $$;
REVOKE ALL ON FUNCTION application_native_governance_revision(uuid,uuid,text) FROM PUBLIC;

CREATE FUNCTION application_native_owner_binding_allows(w uuid,module text,type_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE allowed boolean:=false;
BEGIN
 IF EXISTS(SELECT 1 FROM public.application_native_resource_owners o WHERE o.workspace_id=w
  AND o.origin=jsonb_build_object('kind','generic','entityTypeId',type_id) AND o.resource_type='record.'||type_id)
  OR NOT EXISTS(SELECT 1 FROM public.entity_types t WHERE t.workspace_id=w AND t.id=type_id) THEN RETURN false; END IF;
 -- Roll back the proposed restriction and its epoch changes before a preview
 -- persists. The same deployed readers then prove it again during actual apply.
 BEGIN
  INSERT INTO public.application_native_resource_owners(workspace_id,origin,resource_type,module_key)
   VALUES(w,jsonb_build_object('kind','generic','entityTypeId',type_id),'record.'||type_id,module);
  IF public.application_native_schema_governance_allows(w,type_id) IS NOT TRUE THEN
   RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  RAISE EXCEPTION 'validated restrictive owner binding' USING ERRCODE='P0801';
 EXCEPTION WHEN SQLSTATE 'P0801' THEN allowed:=true;
 END;
 RETURN allowed;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege OR unique_violation THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_native_owner_binding_allows(uuid,text,uuid) FROM PUBLIC;

CREATE FUNCTION application_native_governance_proposal_allows(w uuid,module text,proposal jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid; begins timestamptz; ends timestamptz; target public.application_native_role_assignments;
BEGIN
 IF jsonb_typeof(proposal) IS DISTINCT FROM 'object' OR public.application_native_module_governance_allows(w,module) IS NOT TRUE THEN RETURN false; END IF;
 CASE proposal->>'kind'
 WHEN 'assign_role' THEN
  IF proposal-ARRAY['kind','userId','roleKey','startsAt','expiresAt']<>'{}'::jsonb
   OR NOT proposal ?& ARRAY['kind','userId','roleKey','startsAt','expiresAt']
   OR jsonb_typeof(proposal->'userId') IS DISTINCT FROM 'string' OR jsonb_typeof(proposal->'roleKey') IS DISTINCT FROM 'string'
   OR jsonb_typeof(proposal->'startsAt') IS DISTINCT FROM 'string'
   OR jsonb_typeof(proposal->'expiresAt') NOT IN('string','null')
   OR NOT EXISTS(SELECT 1 FROM public.application_native_field_contracts c WHERE c.module_key=module AND proposal->>'roleKey'=ANY(c.role_keys)) THEN RETURN false; END IF;
  begins:=(proposal->>'startsAt')::timestamptz;ends:=(proposal->>'expiresAt')::timestamptz;
  IF NOT isfinite(begins) OR ends IS NOT NULL AND (NOT isfinite(ends) OR ends<=begins OR ends<=statement_timestamp()) THEN RETURN false; END IF;
  PERFORM 1 FROM public.workspace_members m WHERE m.workspace_id=w AND m.user_id=(proposal->>'userId')::uuid FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  -- Delegation cannot manufacture a role or extend its current issuer horizon.
  RETURN EXISTS(SELECT 1 FROM public.application_native_role_assignments a WHERE a.workspace_id=w AND a.module_key=module AND a.user_id=actor
   AND a.role_key=proposal->>'roleKey' AND a.status='active' AND a.starts_at<=statement_timestamp()
   AND (a.expires_at IS NULL OR a.expires_at>statement_timestamp() AND ends IS NOT NULL AND ends<=a.expires_at));
 WHEN 'revoke_role' THEN
  IF proposal-ARRAY['kind','assignmentId','expectedVersion']<>'{}'::jsonb
   OR NOT proposal ?& ARRAY['kind','assignmentId','expectedVersion'] OR jsonb_typeof(proposal->'assignmentId') IS DISTINCT FROM 'string'
   OR jsonb_typeof(proposal->'expectedVersion') IS DISTINCT FROM 'string' OR proposal->>'expectedVersion' !~ '^[1-9][0-9]*$' THEN RETURN false; END IF;
  SELECT * INTO target FROM public.application_native_role_assignments a WHERE a.workspace_id=w AND a.module_key=module AND a.id=(proposal->>'assignmentId')::uuid FOR SHARE;
  RETURN FOUND AND target.status='active' AND target.version::text=proposal->>'expectedVersion';
 WHEN 'bind_owner' THEN
  IF proposal-ARRAY['kind','entityTypeId']<>'{}'::jsonb OR NOT proposal ?& ARRAY['kind','entityTypeId']
    OR jsonb_typeof(proposal->'entityTypeId') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  RETURN public.application_native_owner_binding_allows(w,module,(proposal->>'entityTypeId')::uuid);
 ELSE RETURN false;
 END CASE;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR datetime_field_overflow OR insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_native_governance_proposal_allows(uuid,text,jsonb) FROM PUBLIC;

CREATE FUNCTION read_native_application_governance_catalog(w uuid,acting uuid,module text,after_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE revision text; roles text[]; assignments jsonb; cursor_id uuid;
BEGIN
 revision:=public.application_native_governance_revision(w,acting,module);
 SELECT c.role_keys INTO roles FROM public.application_native_field_contracts c WHERE c.module_key=module;
 IF roles IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 SELECT coalesce(jsonb_agg(metadata ORDER BY id),'[]'::jsonb) INTO assignments FROM (
  SELECT a.id,jsonb_build_object('id',a.id,'userId',a.user_id,'roleKey',a.role_key,'status',a.status,'startsAt',a.starts_at,
    'expiresAt',a.expires_at,'version',a.version::text,'issuedByUserId',a.issued_by_user_id) AS metadata
   FROM public.application_native_role_assignments a WHERE a.workspace_id=w AND a.module_key=module AND (after_id IS NULL OR a.id>after_id)
   ORDER BY a.id LIMIT 100) page;
 cursor_id:=(assignments->-1->>'id')::uuid;
 IF NOT EXISTS(SELECT 1 FROM public.application_native_role_assignments a WHERE a.workspace_id=w AND a.module_key=module AND a.id>cursor_id) THEN cursor_id:=NULL; END IF;
 RETURN jsonb_build_object('moduleKey',module,'revision',revision,'roleKeys',roles,'operations',ARRAY['assign_role','revoke_role','bind_owner'],
  'roleAssignments',assignments,'nextCursor',cursor_id);
END $$;
REVOKE ALL ON FUNCTION read_native_application_governance_catalog(uuid,uuid,text,uuid) FROM PUBLIC;

CREATE FUNCTION application_prepare_native_governance_review(w uuid,acting uuid,module text,expected text,proposal jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE revision text; review public.application_native_governance_reviews;
BEGIN
 revision:=public.application_native_governance_revision(w,acting,module);
 IF revision IS DISTINCT FROM expected THEN RAISE EXCEPTION 'record_version_conflict: reviewed authority changed' USING ERRCODE='40001'; END IF;
 IF public.application_native_governance_proposal_allows(w,module,proposal) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 INSERT INTO public.application_native_governance_reviews(workspace_id,module_key,actor_user_id,assistant_id,proposal,reviewed_revision)
  VALUES(w,module,nullif(current_setting('app.current_user_id',true),'')::uuid,acting,proposal,revision) RETURNING * INTO review;
 RETURN jsonb_build_object('id',review.id,'moduleKey',module,'revision',revision,'proposal',proposal,'expiresAt',review.expires_at,'canApply',true);
END $$;
REVOKE ALL ON FUNCTION application_prepare_native_governance_review(uuid,uuid,text,text,jsonb) FROM PUBLIC;

CREATE FUNCTION application_apply_native_governance_review(w uuid,acting uuid,review_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE review public.application_native_governance_reviews; revision text; resource_id uuid; target_version text; operation_outcome jsonb;
BEGIN
 SELECT * INTO review FROM public.application_native_governance_reviews r WHERE r.id=review_id AND r.workspace_id=w
  AND r.actor_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND r.assistant_id=acting FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 revision:=public.application_native_governance_revision(w,acting,review.module_key);
 IF revision IS DISTINCT FROM coalesce(review.applied_revision,review.reviewed_revision) THEN
  RAISE EXCEPTION 'record_version_conflict: reviewed authority changed' USING ERRCODE='40001'; END IF;
 IF review.outcome IS NOT NULL THEN RETURN review.outcome; END IF;
 IF review.expires_at<=clock_timestamp() OR public.application_native_governance_proposal_allows(w,review.module_key,review.proposal) IS NOT TRUE THEN
  RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 CASE review.proposal->>'kind'
 WHEN 'assign_role' THEN
  INSERT INTO public.application_native_role_assignments(workspace_id,module_key,user_id,role_key,starts_at,expires_at,issued_by_user_id)
   VALUES(w,review.module_key,(review.proposal->>'userId')::uuid,review.proposal->>'roleKey',(review.proposal->>'startsAt')::timestamptz,
    (review.proposal->>'expiresAt')::timestamptz,review.actor_user_id) RETURNING id,version::text INTO resource_id,target_version;
 WHEN 'revoke_role' THEN
  UPDATE public.application_native_role_assignments a SET status='revoked' WHERE a.workspace_id=w AND a.module_key=review.module_key
   AND a.id=(review.proposal->>'assignmentId')::uuid AND a.version::text=review.proposal->>'expectedVersion' AND a.status='active'
   RETURNING id,version::text INTO resource_id,target_version;
  IF resource_id IS NULL THEN RAISE EXCEPTION 'record_version_conflict' USING ERRCODE='40001'; END IF;
 WHEN 'bind_owner' THEN
  resource_id:=(review.proposal->>'entityTypeId')::uuid;
  INSERT INTO public.application_native_resource_owners(workspace_id,origin,resource_type,module_key)
   VALUES(w,jsonb_build_object('kind','generic','entityTypeId',resource_id),'record.'||resource_id,review.module_key);
  target_version:='1';
 ELSE RAISE EXCEPTION 'invalid_value' USING ERRCODE='22023';
 END CASE;
 -- A self-revocation returns only the explicit operation's content-free
 -- outcome. Lost field governance is never reused for a subsequent read/replay.
 IF review.proposal->>'kind'='revoke_role' AND EXISTS(SELECT 1 FROM public.application_native_role_assignments a
  WHERE a.id=resource_id AND a.user_id=review.actor_user_id) THEN
  revision:=public.application_field_digest(public.read_application_policy_epoch(w,review.actor_user_id,acting));
  IF revision IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 ELSE
  revision:=public.application_native_governance_revision(w,acting,review.module_key);
 END IF;
 operation_outcome:=jsonb_build_object('id',review.id,'moduleKey',review.module_key,'kind',review.proposal->>'kind','resourceId',resource_id,'version',target_version,'applied',true);
 UPDATE public.application_native_governance_reviews r SET applied_revision=revision,outcome=operation_outcome WHERE r.id=review.id;
 INSERT INTO public.application_native_governance_events(review_id,workspace_id,module_key,actor_user_id,operation_kind,resource_id)
  VALUES(review.id,w,review.module_key,review.actor_user_id,review.proposal->>'kind',resource_id);
 RETURN operation_outcome;
END $$;
REVOKE ALL ON FUNCTION application_apply_native_governance_review(uuid,uuid,uuid) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='app_user') THEN
  REVOKE ALL ON application_native_governance_reviews,application_native_governance_events FROM app_user;
  GRANT EXECUTE ON FUNCTION read_native_application_governance_catalog(uuid,uuid,text,uuid),
   application_prepare_native_governance_review(uuid,uuid,text,text,jsonb),application_apply_native_governance_review(uuid,uuid,uuid) TO app_user;
 END IF;
END $$;
COMMIT;
