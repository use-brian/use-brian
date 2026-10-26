-- Metadata-only invocation evidence. This does not qualify application runtime.
-- [COMP:api/policy-epoch]
BEGIN;

CREATE SEQUENCE application_policy_revision_seq;
CREATE TABLE application_policy_workspace_epochs (
 workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 revision bigint NOT NULL CHECK(revision>0)
);
CREATE TABLE application_policy_contract_epoch (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 revision bigint NOT NULL CHECK(revision>0)
);
INSERT INTO application_policy_contract_epoch VALUES(true,nextval('application_policy_revision_seq'));
ALTER TABLE application_policy_workspace_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_policy_contract_epoch ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON application_policy_workspace_epochs,application_policy_contract_epoch,application_policy_revision_seq FROM PUBLIC;

ALTER TABLE application_native_field_contracts ADD COLUMN configuration_required boolean NOT NULL DEFAULT false,
 ADD COLUMN configuration_reader regprocedure;

CREATE FUNCTION application_native_configuration_port_valid(reader regprocedure) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(p.proowner=c.relowner AND p.prosecdef AND p.prokind='f' AND NOT p.proretset
  AND p.prorettype='text'::regtype AND p.proargtypes='2950'::oidvector
  AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE')
  AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname='app_user' AND has_function_privilege(r.oid,p.oid,'EXECUTE')),false)
 FROM pg_proc p CROSS JOIN pg_class c WHERE p.oid=reader AND c.oid='public.application_native_field_contracts'::regclass
$$;
REVOKE ALL ON FUNCTION application_native_configuration_port_valid(regprocedure) FROM PUBLIC;
CREATE FUNCTION application_native_configuration_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.configuration_reader IS NOT NULL AND application_native_configuration_port_valid(NEW.configuration_reader) IS NOT TRUE THEN
  RAISE EXCEPTION 'invalid_native_configuration_port' USING ERRCODE='22023'; END IF;
 -- A missing required port is held at use, including partially installed modules.
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION application_native_configuration_guard() FROM PUBLIC;
CREATE TRIGGER application_native_configuration_guard BEFORE INSERT OR UPDATE ON application_native_field_contracts
 FOR EACH ROW EXECUTE FUNCTION application_native_configuration_guard();

CREATE FUNCTION application_policy_epoch_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w uuid; old_w uuid;
BEGIN
 IF TG_TABLE_NAME='application_native_field_contracts' THEN
  UPDATE application_policy_contract_epoch SET revision=nextval('application_policy_revision_seq');
  RETURN NULL;
 END IF;
 IF TG_OP<>'DELETE' THEN
  w:=CASE WHEN TG_TABLE_NAME='workspaces' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'workspace_id')::uuid END;
 END IF;
 IF TG_OP<>'INSERT' THEN
  old_w:=CASE WHEN TG_TABLE_NAME='workspaces' THEN (to_jsonb(OLD)->>'id')::uuid ELSE (to_jsonb(OLD)->>'workspace_id')::uuid END;
 END IF;
 FOR w IN SELECT DISTINCT id FROM unnest(ARRAY[w,old_w]) id WHERE id IS NOT NULL LOOP
  -- Parent deletion and FK cascades do not recreate erased epoch rows.
  IF EXISTS(SELECT 1 FROM workspaces WHERE id=w) THEN
   INSERT INTO application_policy_workspace_epochs(workspace_id,revision) VALUES(w,nextval('application_policy_revision_seq'))
    ON CONFLICT(workspace_id) DO UPDATE SET revision=nextval('application_policy_revision_seq');
  END IF;
 END LOOP;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_policy_epoch_changed() FROM PUBLIC;
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['application_native_field_contracts','application_native_role_assignments',
  'application_native_resource_owners','entity_types','workspaces','workspace_members','workspace_access_policies',
  'department_edges','project_shared_members','workspace_modules','assistants','application_clients',
  'application_access_grants','application_api_credentials','application_credential_grants','application_oauth_bindings'] LOOP
  EXECUTE format('CREATE TRIGGER application_policy_epoch_changed AFTER INSERT OR UPDATE OR DELETE ON public.%I
   FOR EACH ROW EXECUTE FUNCTION public.application_policy_epoch_changed()',relation);
 END LOOP;
END $$;

-- Hash deployed code/ACL/configuration metadata as well as the registry revision.
-- CREATE OR REPLACE / ACL tampering does not necessarily update a registry row.
CREATE FUNCTION application_policy_port_fingerprint(reader regprocedure) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT application_field_digest(to_jsonb(p)) FROM pg_proc p WHERE p.oid=reader
$$;
REVOKE ALL ON FUNCTION application_policy_port_fingerprint(regprocedure) FROM PUBLIC;

-- Private host metadata reader: no actor substitution, payload read or permission result.
CREATE FUNCTION read_application_policy_epoch(w uuid,actor uuid,acting uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE contract application_native_field_contracts; configurations jsonb:='[]'; revision text;
 namespace text; procedure_name text; timed text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM workspaces WHERE id=w)
  OR NOT EXISTS(SELECT 1 FROM users WHERE id=actor)
  OR NOT EXISTS(SELECT 1 FROM assistants WHERE id=acting AND workspace_id=w) THEN RETURN NULL; END IF;
 FOR contract IN SELECT c.* FROM application_native_field_contracts c WHERE EXISTS(
  SELECT 1 FROM application_native_resource_owners o WHERE o.workspace_id=w AND o.module_key=c.module_key) ORDER BY c.module_key LOOP
  IF application_native_record_port_valid(contract.metadata_reader) IS NOT TRUE
   OR contract.catalog_reader IS NOT NULL AND application_native_catalog_port_valid(contract.catalog_reader) IS NOT TRUE
   OR contract.configuration_required AND contract.configuration_reader IS NULL THEN RETURN NULL; END IF;
  revision:=NULL;
  IF contract.configuration_reader IS NOT NULL THEN
   IF application_native_configuration_port_valid(contract.configuration_reader) IS NOT TRUE THEN RETURN NULL; END IF;
   SELECT n.nspname,p.proname INTO namespace,procedure_name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE p.oid=contract.configuration_reader;
   EXECUTE format('SELECT %I.%I($1)',namespace,procedure_name) INTO revision USING w;
   IF revision IS NULL OR length(revision) NOT BETWEEN 1 AND 256 OR revision !~ '^[A-Za-z0-9_.:-]+$' THEN RETURN NULL; END IF;
  END IF;
  configurations:=configurations||jsonb_build_array(jsonb_build_object('moduleKey',contract.module_key,
   'contractVersion',contract.contract_version,'configurationRevision',revision,
   'ports',application_field_digest(jsonb_build_array(application_policy_port_fingerprint(contract.metadata_reader),
    application_policy_port_fingerprint(contract.catalog_reader),application_policy_port_fingerprint(contract.configuration_reader)))));
 END LOOP;
 -- Timed transitions must invalidate even when no metadata row was written.
 SELECT application_field_digest(jsonb_build_object(
  'roles',(SELECT jsonb_agg(a.id ORDER BY a.id) FROM application_native_role_assignments a WHERE a.workspace_id=w
   AND a.status='active' AND a.starts_at<=statement_timestamp() AND (a.expires_at IS NULL OR a.expires_at>statement_timestamp())),
  'departments',(SELECT jsonb_agg(d.id ORDER BY d.id) FROM department_edges d WHERE d.workspace_id=w AND (d.expires_at IS NULL OR d.expires_at>statement_timestamp())),
  'projects',(SELECT jsonb_agg(p.id ORDER BY p.id) FROM project_shared_members p WHERE p.workspace_id=w AND (p.expires_at IS NULL OR p.expires_at>statement_timestamp())))) INTO timed;
 RETURN jsonb_build_object('version',1,'workspaceId',w,'principalId',actor,'assistantId',acting,
  'workspaceRevision',coalesce((SELECT e.revision::text FROM application_policy_workspace_epochs e WHERE e.workspace_id=w),'0'),
  'contractRevision',(SELECT e.revision::text FROM application_policy_contract_epoch e),
  'timedState',timed,'modules',configurations);
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION read_application_policy_epoch(uuid,uuid,uuid) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  REVOKE ALL ON application_policy_workspace_epochs,application_policy_contract_epoch,application_policy_revision_seq FROM app_user;
  REVOKE ALL ON FUNCTION application_native_configuration_port_valid(regprocedure),application_native_configuration_guard(),
   application_policy_epoch_changed(),application_policy_port_fingerprint(regprocedure),read_application_policy_epoch(uuid,uuid,uuid) FROM app_user;
 END IF;
END $$;
COMMIT;
