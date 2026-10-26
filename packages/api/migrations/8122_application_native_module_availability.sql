-- Spec: docs/architecture/features/application-platform.md: protected module lifecycle.
-- [COMP:api/application-governance] Manual availability is not complete data governance.
BEGIN;
CREATE FUNCTION application_native_module_lifecycle_revision(w uuid,acting uuid,module text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 owned public.application_native_resource_owners;catalog jsonb;scope jsonb;deployed jsonb;epoch jsonb;catalogs jsonb:='[]';
BEGIN
 -- Generic and built-in native modules keep their complete original authority.
 IF NOT EXISTS(SELECT 1 FROM public.application_native_resource_owners o WHERE o.workspace_id=w AND o.module_key=module
  AND module NOT IN('native','records') AND o.origin=jsonb_build_object('kind','native','moduleKey',module)) THEN
  RETURN public.application_native_governance_revision(w,acting,module);
 END IF;
 -- A custom catalog cannot discharge another owner's complete governance proof.
 IF EXISTS(SELECT 1 FROM public.application_native_resource_owners o WHERE o.workspace_id=w AND o.module_key=module
  AND o.origin<>jsonb_build_object('kind','native','moduleKey',module)) THEN RAISE EXCEPTION 'access_unavailable: mixed module ownership' USING ERRCODE='42501';END IF;
 IF actor IS NULL OR acting IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR public.application_governance_allows(w) IS NOT TRUE
  OR public.assistant_placement_visible(actor,acting) IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM public.assistants a WHERE a.id=acting AND a.workspace_id=w)
  OR nullif(current_setting('app.v2_assistant_id',true),'') IS NOT NULL AND current_setting('app.v2_assistant_id',true)::uuid<>acting
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_class c ON c.oid='public.application_native_field_contracts'::regclass
   WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'MEMBER')))
  OR EXISTS(SELECT 1 FROM public.application_native_role_assignments a WHERE a.workspace_id=w AND a.user_id=actor AND a.status='active'
   AND (a.starts_at<=statement_timestamp() AND (a.expires_at IS NULL OR a.expires_at>statement_timestamp())) IS DISTINCT FROM
    (a.starts_at<=clock_timestamp() AND (a.expires_at IS NULL OR a.expires_at>clock_timestamp()))) THEN
  RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM public.workspace_members m WHERE m.workspace_id=w AND m.user_id=actor AND m.role IN('owner','admin') FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 deployed:=public.application_deployed_module_state(w,module);
 IF deployed IS NULL THEN RAISE EXCEPTION 'access_unavailable: deployed module unavailable' USING ERRCODE='42501';END IF;
 FOR owned IN SELECT o.* FROM public.application_native_resource_owners o WHERE o.workspace_id=w AND o.module_key=module
  ORDER BY o.resource_type,o.origin::text FOR SHARE LOOP
  catalog:=public.application_native_field_catalog_for(w,owned.origin,owned.resource_type);
  IF catalog->>'registered' IS DISTINCT FROM 'true' OR catalog->>'held' IS DISTINCT FROM 'false'
   OR catalog#>>'{metadata,moduleKey}' IS DISTINCT FROM module OR catalog#>'{metadata,origin}' IS DISTINCT FROM owned.origin
   OR catalog#>>'{metadata,typeKey}' IS DISTINCT FROM owned.resource_type
   OR public.read_native_application_field_catalog(w,owned.origin,owned.resource_type) IS NULL THEN
   RAISE EXCEPTION 'access_unavailable: native catalog unavailable' USING ERRCODE='42501';END IF;
  scope:=catalog#>'{metadata,scope}';
  IF public.member_operation_row_allows(public.member_principal_operation_grants(actor,true,w),w,scope->>'sensitivity',
    ARRAY(SELECT jsonb_array_elements_text(scope->'compartments'))) IS NOT TRUE
   OR public.agent_mutation_scope_allows(ARRAY(SELECT jsonb_array_elements_text(scope->'compartments'))) IS NOT TRUE THEN
   RAISE EXCEPTION 'access_unavailable: native catalog scope unavailable' USING ERRCODE='42501';END IF;
  catalogs:=catalogs||jsonb_build_array(jsonb_build_object('owner',to_jsonb(owned),'catalog',catalog));
 END LOOP;
 epoch:=public.read_application_policy_epoch(w,actor,acting);
 IF epoch IS NULL THEN RAISE EXCEPTION 'access_unavailable: native policy unavailable' USING ERRCODE='42501';END IF;
 RETURN public.application_field_digest(jsonb_build_object('purpose','native_module_availability_v1','workspaceId',w,'moduleKey',module,
  'actor',actor,'assistant',acting,'epoch',epoch,'deployed',deployed,'catalogs',catalogs));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN
 RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';
END $$;
REVOKE ALL ON FUNCTION application_native_module_lifecycle_revision(uuid,uuid,text) FROM PUBLIC;

-- Closed current consumers; preserve every other byte, ABI, grant and lock.
DO $migration$
DECLARE item record;definition text;
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('application_prepare_native_module_lifecycle(uuid,text,text,integer,text)','ceaa75d62cfdd63bf4053ded451ca0bd'),
  ('application_guard_native_module_lifecycle()','9cce58dada1563e478b83f9ba39e0253'),
  ('application_record_native_module_lifecycle()','abd9c93d3752e381760b7a249028b907'),
  ('application_finish_native_module_lifecycle(uuid,text)','6317b0f390d29a978ebd8a8e89402723')
 ) expected(signature,body_digest) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_class c ON c.oid='public.application_native_field_contracts'::regclass
   WHERE p.oid=('public.'||item.signature)::regprocedure AND p.proowner=c.relowner AND p.prosecdef AND p.prokind='f'
    AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp'] AND md5(p.prosrc)=item.body_digest) THEN
   RAISE EXCEPTION 'native_lifecycle_prerequisite_changed: %',item.signature;END IF;
  definition:=pg_get_functiondef(('public.'||item.signature)::regprocedure);
  IF (length(definition)-length(replace(definition,'application_native_governance_revision(','')))/length('application_native_governance_revision(')<>1 THEN
   RAISE EXCEPTION 'native_lifecycle_prerequisite_changed: revision call %',item.signature;END IF;
  EXECUTE replace(definition,'application_native_governance_revision(','application_native_module_lifecycle_revision(');
 END LOOP;
END $migration$;
COMMIT;
