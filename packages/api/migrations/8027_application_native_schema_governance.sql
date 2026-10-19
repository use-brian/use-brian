BEGIN;
-- [COMP:api/application-records] Protected parent schemas cannot bypass cell authority.
-- Reads policy/scope/version metadata only, never canonical business values.
CREATE FUNCTION application_native_schema_governance_allows(w uuid,type_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE resource_origin jsonb:=jsonb_build_object('kind','generic','entityTypeId',type_id); type_key text:='record.'||type_id;
 fields jsonb; catalog jsonb; policy jsonb; source record;
BEGIN
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=w
    AND m.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid) THEN RETURN false; END IF;
 SELECT coalesce(jsonb_agg(p->'name'),'[]'::jsonb) INTO fields FROM public.entity_types t,
  LATERAL jsonb_array_elements(t.properties) p WHERE t.workspace_id=w AND t.id=type_id;
 IF NOT EXISTS(SELECT 1 FROM public.entity_types t WHERE t.workspace_id=w AND t.id=type_id) THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.application_native_resource_owners o
  WHERE o.workspace_id=w AND o.origin=resource_origin AND o.resource_type=type_key) THEN RETURN true; END IF;
 IF public.application_governance_allows(w) IS NOT TRUE THEN RETURN false; END IF;
 catalog:=public.read_native_application_field_catalog(w,resource_origin,type_key);
 IF catalog IS NULL OR NOT coalesce(fields<@(catalog->'readFields') AND fields<@(catalog->'writeFields'),false) THEN RETURN false; END IF;
 FOR source IN SELECT r.id,r.sensitivity,r.compartments,r.project_ids FROM public.entity_instances r
  WHERE r.workspace_id=w AND r.entity_type_id=type_id ORDER BY r.id FOR SHARE LOOP
  IF public.scope_review_state_held('entity_instance',source.id)
   OR public.context_scope_allows_current_principal(w,source.sensitivity,source.compartments,source.project_ids) IS NOT TRUE
   OR public.member_operation_scope_allows(w,source.sensitivity,source.compartments,true) IS NOT TRUE
   OR public.agent_mutation_scope_allows(source.compartments) IS NOT TRUE THEN RETURN false; END IF;
  policy:=public.application_current_native_field_policy(w,resource_origin,type_key,source.id);
  IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false'
   OR NOT coalesce(fields<@(policy->'readFields') AND fields<@(policy->'writeFields'),false) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_native_schema_governance_allows(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION application_guard_native_schema_governance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE schema_row public.entity_types;
BEGIN
 IF TG_OP='DELETE' THEN schema_row:=OLD; ELSE schema_row:=NEW; END IF;
 IF TG_OP='DELETE' AND TG_WHEN='AFTER' THEN
  DELETE FROM public.application_native_resource_owners o WHERE o.workspace_id=OLD.workspace_id
   AND o.origin=jsonb_build_object('kind','generic','entityTypeId',OLD.id) AND o.resource_type='record.'||OLD.id;
  RETURN OLD;
 END IF;
 -- A vanished workspace remains governed by its separate canonical deletion.
 IF NOT EXISTS(SELECT 1 FROM public.workspaces w WHERE w.id=schema_row.workspace_id) THEN
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM public.application_native_resource_owners o WHERE o.workspace_id=schema_row.workspace_id
  AND o.origin=jsonb_build_object('kind','generic','entityTypeId',schema_row.id) AND o.resource_type='record.'||schema_row.id)
  AND public.application_native_schema_governance_allows(schema_row.workspace_id,schema_row.id) IS NOT TRUE THEN
  RAISE EXCEPTION 'access_unavailable: current protected schema governance unavailable' USING ERRCODE='42501'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
REVOKE ALL ON FUNCTION application_guard_native_schema_governance() FROM PUBLIC;
CREATE TRIGGER application_native_schema_authority BEFORE UPDATE OR DELETE ON public.entity_types
 FOR EACH ROW EXECUTE FUNCTION public.application_guard_native_schema_governance();
-- Recheck the complete new catalog too; undeclared/new policy keys cannot commit
-- a held or weaker protected schema through an otherwise authorized old catalog.
CREATE TRIGGER application_native_schema_result_authority AFTER UPDATE OR DELETE ON public.entity_types
 FOR EACH ROW EXECUTE FUNCTION public.application_guard_native_schema_governance();

CREATE FUNCTION application_schema_governance_revision(w uuid,type_id uuid,acting uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid; epoch jsonb;
BEGIN
 IF public.application_native_schema_governance_allows(w,type_id) IS NOT TRUE
  OR acting IS NULL OR public.assistant_placement_visible(actor,acting) IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM public.assistants a WHERE a.id=acting AND a.workspace_id=w)
  OR nullif(current_setting('app.v2_assistant_id',true),'') IS NOT NULL
   AND current_setting('app.v2_assistant_id',true)::uuid<>acting THEN
  RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 epoch:=public.read_application_policy_epoch(w,actor,acting);
 IF epoch IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 RETURN public.application_field_digest(epoch);
END $$;
REVOKE ALL ON FUNCTION application_schema_governance_revision(uuid,uuid,uuid) FROM PUBLIC;

ALTER TABLE public.application_schema_change_reviews
 ADD COLUMN review_assistant_id uuid REFERENCES public.assistants(id) ON DELETE CASCADE,
 ADD COLUMN reviewed_authority_revision text CHECK(reviewed_authority_revision ~ '^[0-9a-f]{64}$'),
 ADD COLUMN applied_authority_revision text CHECK(applied_authority_revision ~ '^[0-9a-f]{64}$');
CREATE OR REPLACE FUNCTION application_schema_review_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['applied_version','applied_authority_revision']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['applied_version','applied_authority_revision'])
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_class c ON c.oid='public.application_schema_change_reviews'::regclass
   WHERE r.rolname=current_user AND c.relowner=r.oid) THEN
  RAISE EXCEPTION 'invalid_value: immutable schema review' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION application_schema_review_immutable() FROM PUBLIC;
CREATE OR REPLACE FUNCTION application_finish_schema_review(p_id uuid,p_version integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE review public.application_schema_change_reviews; revision text;
BEGIN
 SELECT * INTO review FROM public.application_schema_change_reviews r WHERE r.id=p_id
  AND r.actor_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid FOR UPDATE;
 IF NOT FOUND OR review.review_assistant_id IS NULL OR review.reviewed_authority_revision IS NULL THEN
  RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 revision:=public.application_schema_governance_revision(review.workspace_id,review.entity_type_id,review.review_assistant_id);
 UPDATE public.application_schema_change_reviews r SET applied_version=p_version,applied_authority_revision=revision
  WHERE r.id=p_id AND r.applied_version IS NULL AND r.invalid_records=0 AND r.expires_at>now()
   AND EXISTS(SELECT 1 FROM public.entity_types t WHERE t.id=r.entity_type_id AND t.workspace_id=r.workspace_id
    AND t.properties=r.proposed_properties AND t.schema_version=p_version);
 IF NOT FOUND THEN RAISE EXCEPTION 'schema_version_conflict' USING ERRCODE='22023'; END IF;
END $$;
REVOKE ALL ON FUNCTION application_finish_schema_review(uuid,integer) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='app_user') THEN
  GRANT EXECUTE ON FUNCTION application_native_schema_governance_allows(uuid,uuid),application_schema_governance_revision(uuid,uuid,uuid) TO app_user;
 END IF;
END $$;
COMMIT;
