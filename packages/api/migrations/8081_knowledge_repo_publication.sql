-- [COMP:api/application-persistence] Actual-actor source-backed Knowledge publication.
-- Reuses existing retained-frame pins and immutable native capture/archive helpers.
CREATE TABLE knowledge_repo_publication_heads (
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 entry_id uuid NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,
 entry_version text NOT NULL,
 PRIMARY KEY(workspace_id,entry_id,entry_version)
);
REVOKE ALL ON knowledge_repo_publication_heads FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 REVOKE ALL ON knowledge_repo_publication_heads FROM app_user;
END IF;END $$;

CREATE FUNCTION admit_knowledge_repo_write(p jsonb,e jsonb,sources jsonb,target_id uuid,expected_version text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 w uuid:=(p->>'workspaceId')::uuid;s workspace_knowledge_sources;old knowledge_entries;
 context jsonb;catalog jsonb;mask jsonb;fields text[];source jsonb;current jsonb;field text;
BEGIN
 IF actor IS NULL OR actor::text IS DISTINCT FROM p->>'actorId'
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL OR current_setting('app.system_bypass',true)='true'
  OR nullif(current_setting('app.agent_workspace_id',true),'') IS DISTINCT FROM w::text
  OR nullif(current_setting('app.agent_actor_id',true),'') IS DISTINCT FROM actor::text
  OR NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor)
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.knowledge_entries'::regclass
    WHERE r.rolname=session_user AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
  OR jsonb_typeof(sources) IS DISTINCT FROM 'array' OR jsonb_array_length(sources) NOT BETWEEN 1 AND 1000
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(sources) x WHERE x->>'resourceKind'='application_field')
  OR entity_derivation_envelope_valid(p||jsonb_build_object('userId',NULL,'assistantId',NULL)) IS NOT TRUE
  THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='42501';END IF;
 SELECT * INTO s FROM workspace_knowledge_sources WHERE workspace_id=w AND id=(p->>'sourceId')::uuid FOR SHARE;
 IF s.id IS NULL OR s.binding_held OR s.configured_by_user_id IS NULL
  OR s.id::text IS DISTINCT FROM e->>'id' OR s.workspace_id::text IS DISTINCT FROM e->>'workspaceId'
  OR s.binding_version::text IS DISTINCT FROM e->>'bindingVersion'
  OR s.repo IS DISTINCT FROM e->>'repo' OR s.branch IS DISTINCT FROM e->>'branch'
  OR s.root_path IS DISTINCT FROM e->>'rootPath' OR s.source_type IS DISTINCT FROM e->>'sourceType'
  OR s.connector_instance_id::text IS DISTINCT FROM e->>'connectorInstanceId'
  OR(s.source_type='github' AND s.write_access IS DISTINCT FROM true)
  OR(s.sync_run_id IS NOT NULL AND s.sync_lease_until>clock_timestamp())
  THEN RAISE EXCEPTION 'knowledge_source_changed' USING ERRCODE='42501';END IF;
 IF member_operation_scope_allows(w,s.binding_sensitivity,s.binding_compartments,true) IS NOT TRUE
  OR agent_mutation_scope_allows(s.binding_compartments) IS NOT TRUE
  OR agent_read_scope_allows(s.binding_sensitivity,s.binding_compartments,s.binding_project_ids) IS NOT TRUE
  OR read_entity_derivation_source(w,'knowledge_source',s.id) IS NULL
  OR sensitivity_rank(p->>'sensitivity')<sensitivity_rank(s.binding_sensitivity)
  OR NOT(p->'compartments')@>to_jsonb(s.binding_compartments) OR NOT(p->'projectIds')@>to_jsonb(s.binding_project_ids)
  THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 SELECT * INTO old FROM knowledge_entries WHERE workspace_id=w AND path=p->>'path' FOR UPDATE;
 IF target_id IS NULL THEN
  IF old.id IS NOT NULL OR expected_version IS NOT NULL THEN RAISE EXCEPTION 'knowledge_source_target_conflict';END IF;
  fields:=ARRAY['path','title','content','summary','tags','metadata'];
  IF native_knowledge_creation_fields_allowed(w,fields,NULL,NULL) IS NOT TRUE THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 ELSE
  IF old.id IS DISTINCT FROM target_id OR old.source_id IS DISTINCT FROM s.id OR old.scope_held
   OR old.scope_version::text IS DISTINCT FROM expected_version
   OR native_knowledge_version_fields_allowed(w,old.id,application_knowledge_field_keys()) IS NOT TRUE
   OR application_canonical_ancestry_allowed(w,'knowledge_entry',old.id,expected_version,true) IS NOT TRUE
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(sources) x WHERE x->>'resourceKind'='knowledge_entry'
     AND x->>'resourceId'=old.id::text AND x->>'version'=expected_version)
   THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  fields:=ARRAY['content'];
  IF old.title IS DISTINCT FROM p->>'title' THEN fields:=array_append(fields,'title');END IF;
  IF old.summary IS DISTINCT FROM p->>'summary' THEN fields:=array_append(fields,'summary');END IF;
  IF to_jsonb(old.tags) IS DISTINCT FROM p->'tags' THEN fields:=array_append(fields,'tags');END IF;
  IF old.metadata IS DISTINCT FROM p->'metadata' THEN fields:=array_append(fields,'metadata');END IF;
  context:=application_knowledge_query_context(w);
  IF context IS NULL THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
  IF context#>>'{policy,nativeDefault}' IS DISTINCT FROM 'true' THEN
   catalog:=read_native_application_field_catalog(w,'{"kind":"native","moduleKey":"native"}','knowledge_entry');
   mask:=read_native_application_field_mask(w,'{"kind":"native","moduleKey":"native"}','knowledge_entry',old.id::text,expected_version);
   FOREACH field IN ARRAY fields LOOP
    IF catalog IS NULL OR mask IS NULL OR NOT coalesce(catalog->'writeFields' ? field,false)
     OR NOT coalesce(mask->'writeFields' ? field,false) THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
   END LOOP;
  END IF;
 END IF;
 IF member_operation_scope_allows(w,p->>'sensitivity',ARRAY(SELECT jsonb_array_elements_text(p->'compartments')),true) IS NOT TRUE
  OR agent_mutation_scope_allows(ARRAY(SELECT jsonb_array_elements_text(p->'compartments'))) IS NOT TRUE
  OR agent_read_scope_allows(p->>'sensitivity',ARRAY(SELECT jsonb_array_elements_text(p->'compartments')),ARRAY(SELECT jsonb_array_elements_text(p->'projectIds')::uuid)) IS NOT TRUE
  THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 FOR source IN SELECT value FROM jsonb_array_elements(sources) LOOP
  IF entity_derivation_envelope_valid(source) IS NOT TRUE OR source->>'workspaceId' IS DISTINCT FROM w::text THEN RAISE EXCEPTION 'scope_evidence_missing';END IF;
  IF source->>'resourceKind'='external_source' THEN
   IF external_source_retention_allowed(w,(source->>'resourceId')::uuid,source->>'version') IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed';END IF;
   current:=external_source_snapshot(w,(source->>'resourceId')::uuid);
  ELSE current:=read_entity_derivation_source(w,source->>'resourceKind',(source->>'resourceId')::uuid);END IF;
  IF current IS NULL OR current->>'held' IS DISTINCT FROM 'false' OR current->>'version' IS DISTINCT FROM source->>'version'
   OR current->>'validTo' IS NOT NULL OR current->>'retractedAt' IS NOT NULL
   OR(current->'workspaceId',current->'userId',current->'assistantId',current->'sensitivity') IS DISTINCT FROM(source->'workspaceId',source->'userId',source->'assistantId',source->'sensitivity')
   OR NOT(current->'compartments')@>(source->'compartments') OR NOT(source->'compartments')@>(current->'compartments')
   OR NOT(current->'projectIds')@>(source->'projectIds') OR NOT(source->'projectIds')@>(current->'projectIds') THEN RAISE EXCEPTION 'scope_source_changed';END IF;
  IF source->>'userId' IS NOT NULL AND source->>'userId' IS DISTINCT FROM actor::text
   OR sensitivity_rank(source->>'sensitivity')>sensitivity_rank(p->>'sensitivity')
   OR NOT(p->'compartments')@>(source->'compartments') OR NOT(p->'projectIds')@>(source->'projectIds') THEN RAISE EXCEPTION 'scope_visibility_incompatible';END IF;
 END LOOP;
END $$;

CREATE FUNCTION publish_admitted_knowledge_repo_write(p jsonb,e jsonb,sources jsonb,target_id uuid,expected_version text)
RETURNS SETOF knowledge_entries LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w uuid:=(p->>'workspaceId')::uuid;output knowledge_entries;prior_revision uuid;next_revision uuid;derivation uuid;
BEGIN
 PERFORM admit_knowledge_repo_write(p,e,sources,target_id,expected_version);
 IF e->>'sourceType'='github' AND coalesce(p->>'sourceSha','')='' THEN RAISE EXCEPTION 'knowledge_source_changed';END IF;
 IF target_id IS NOT NULL THEN
  prior_revision:=capture_native_knowledge_version(w,target_id,expected_version,application_knowledge_field_keys());
  PERFORM archive_native_knowledge_version(w,target_id,expected_version,prior_revision);
  INSERT INTO knowledge_entry_scope_revisions(workspace_id,entry_id,sensitivity,compartments,project_ids,revision_kind)
   VALUES(w,target_id,p->>'sensitivity',ARRAY(SELECT jsonb_array_elements_text(p->'compartments')),ARRAY(SELECT jsonb_array_elements_text(p->'projectIds')::uuid),'body') RETURNING id INTO next_revision;
  INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
   SELECT w,'knowledge_entry_revision',next_revision,'1','knowledge-repo-write',NULL,NULL,p->>'sensitivity',
    ARRAY(SELECT jsonb_array_elements_text(p->'compartments')),ARRAY(SELECT jsonb_array_elements_text(p->'projectIds')::uuid),revision
   FROM workspace_access_policies WHERE workspace_id=w RETURNING id INTO derivation;
  INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
   SELECT DISTINCT w,derivation,x->>'resourceKind',(x->>'resourceId')::uuid,x->>'version'
    FROM jsonb_array_elements(sources||jsonb_build_array(jsonb_build_object('resourceKind','knowledge_source','resourceId',e->>'id','version',e->>'bindingVersion'))) x;
  -- Same pre-mutation validation boundary as the canonical manual body updater.
  SET CONSTRAINTS application_field_derivation_dependencies,page_derivation_dependencies,workflow_derivation_dependencies IMMEDIATE;
  SET CONSTRAINTS application_field_derivation_dependencies,page_derivation_dependencies,workflow_derivation_dependencies DEFERRED;
  UPDATE knowledge_entries SET title=p->>'title',summary=p->>'summary',content=p->>'content',
   tags=ARRAY(SELECT jsonb_array_elements_text(p->'tags')),sensitivity=p->>'sensitivity',sensitivity_explicit=(p->>'sensitivityExplicit')::boolean,
   metadata=coalesce(p->'metadata','{}'),source_sha=p->>'sourceSha',compartments=ARRAY(SELECT jsonb_array_elements_text(p->'compartments')),
   project_ids=ARRAY(SELECT jsonb_array_elements_text(p->'projectIds')::uuid),updated_at=now()
   WHERE workspace_id=w AND id=target_id AND scope_version::text=expected_version RETURNING * INTO output;
  IF NOT FOUND THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  PERFORM publish_native_knowledge_body_revision(w,target_id,output.scope_version::text,next_revision);
 ELSE
 INSERT INTO knowledge_entries(workspace_id,path,title,summary,content,tags,sensitivity,sensitivity_explicit,metadata,source_id,source_sha,created_by,compartments,project_ids)
  VALUES(w,p->>'path',p->>'title',p->>'summary',p->>'content',ARRAY(SELECT jsonb_array_elements_text(p->'tags')),p->>'sensitivity',(p->>'sensitivityExplicit')::boolean,
   coalesce(p->'metadata','{}'),(p->>'sourceId')::uuid,p->>'sourceSha',(p->>'actorId')::uuid,ARRAY(SELECT jsonb_array_elements_text(p->'compartments')),ARRAY(SELECT jsonb_array_elements_text(p->'projectIds')::uuid))
 ON CONFLICT(workspace_id,path) DO UPDATE SET title=EXCLUDED.title,summary=EXCLUDED.summary,content=EXCLUDED.content,tags=EXCLUDED.tags,
  sensitivity=EXCLUDED.sensitivity,sensitivity_explicit=EXCLUDED.sensitivity_explicit,metadata=EXCLUDED.metadata,source_sha=EXCLUDED.source_sha,
  compartments=EXCLUDED.compartments,project_ids=EXCLUDED.project_ids,updated_at=now()
 RETURNING * INTO output;
 INSERT INTO workspace_access_policies(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;
 INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
  SELECT w,'knowledge_entry',output.id,output.scope_version::text,'knowledge-repo-write',NULL,NULL,output.sensitivity,output.compartments,output.project_ids,revision
  FROM workspace_access_policies WHERE workspace_id=w RETURNING id INTO derivation;
 INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
  SELECT DISTINCT w,derivation,x->>'resourceKind',(x->>'resourceId')::uuid,x->>'version'
   FROM jsonb_array_elements(sources||jsonb_build_array(jsonb_build_object('resourceKind','knowledge_source','resourceId',e->>'id','version',e->>'bindingVersion'))) x;
 END IF;
 INSERT INTO knowledge_repo_publication_heads VALUES(w,output.id,output.scope_version::text) ON CONFLICT DO NOTHING;
 SET CONSTRAINTS application_field_derivation_dependencies,page_derivation_dependencies,workflow_derivation_dependencies IMMEDIATE;
 SET CONSTRAINTS application_field_derivation_dependencies,page_derivation_dependencies,workflow_derivation_dependencies DEFERRED;
 RETURN NEXT output;
END $$;

-- Worker imports remain available for ordinary entries. Tool-published versions
-- cannot be replaced by a binding-only sync that would discard original ancestry.
CREATE FUNCTION guard_knowledge_repo_publication() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.scope_version IS DISTINCT FROM OLD.scope_version
  AND NOT(NOT OLD.scope_held AND NEW.scope_held
    AND(entity_scope_semantic_row(to_jsonb(NEW))-'scope_held') IS NOT DISTINCT FROM(entity_scope_semantic_row(to_jsonb(OLD))-'scope_held'))
  AND EXISTS(SELECT 1 FROM knowledge_repo_publication_heads h WHERE h.workspace_id=OLD.workspace_id AND h.entry_id=OLD.id)
  AND NOT EXISTS(SELECT 1 FROM knowledge_repo_publication_heads h WHERE h.workspace_id=NEW.workspace_id AND h.entry_id=NEW.id AND h.entry_version=NEW.scope_version::text)
  THEN RAISE EXCEPTION 'knowledge_repo_reconciliation_required' USING ERRCODE='42501';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER knowledge_repo_publication_guard AFTER UPDATE ON knowledge_entries
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_knowledge_repo_publication();
REVOKE ALL ON FUNCTION admit_knowledge_repo_write(jsonb,jsonb,jsonb,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION publish_admitted_knowledge_repo_write(jsonb,jsonb,jsonb,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_knowledge_repo_publication() FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION admit_knowledge_repo_write(jsonb,jsonb,jsonb,uuid,text) TO app_user;
 GRANT EXECUTE ON FUNCTION publish_admitted_knowledge_repo_write(jsonb,jsonb,jsonb,uuid,text) TO app_user;
END IF;END $$;

-- A source-worker service port, not an attended retained-execution substitute.
-- Its envelope is derived only from the current canonical source binding.
CREATE FUNCTION apply_knowledge_source_refresh(p jsonb,e jsonb) RETURNS SETOF knowledge_entries
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w uuid:=(p->>'workspaceId')::uuid;s workspace_knowledge_sources;old knowledge_entries;output knowledge_entries;
 actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 prior_revision uuid;next_revision uuid;derivation uuid;context jsonb;catalog jsonb;mask jsonb;field text;fields text[];
 setting record;saved jsonb:='{}';node record;current jsonb;
BEGIN
 PERFORM assert_bound_knowledge_sync_actor(w,(p->>'sourceId')::uuid);
 SELECT * INTO s FROM workspace_knowledge_sources WHERE workspace_id=w AND id=(p->>'sourceId')::uuid FOR SHARE;
 IF s.id IS NULL OR s.binding_held OR s.sync_run_id IS NULL OR s.sync_lease_until IS NULL OR s.sync_run_id::text IS DISTINCT FROM e->>'syncRunId'
  OR s.sync_lease_until<=clock_timestamp() OR s.binding_version::text IS DISTINCT FROM e->>'bindingVersion'
  OR s.id::text IS DISTINCT FROM e->>'id' OR w::text IS DISTINCT FROM e->>'workspaceId'
  OR s.repo IS DISTINCT FROM e->>'repo' OR s.branch IS DISTINCT FROM e->>'branch' OR s.root_path IS DISTINCT FROM e->>'rootPath'
  OR s.source_type IS DISTINCT FROM e->>'sourceType' OR s.connector_instance_id::text IS DISTINCT FROM e->>'connectorInstanceId'
  OR s.last_synced_sha IS DISTINCT FROM e->>'lastSyncedSha' OR s.configured_by_user_id::text IS DISTINCT FROM e->>'configuredByUserId'
  OR s.binding_sensitivity IS DISTINCT FROM e->>'bindingSensitivity'
  OR to_jsonb(s.binding_compartments) IS DISTINCT FROM e->'bindingCompartments'
  OR to_jsonb(s.binding_project_ids) IS DISTINCT FROM e->'bindingProjectIds'
  THEN RAISE EXCEPTION 'knowledge_source_changed' USING ERRCODE='42501';END IF;
 SELECT * INTO old FROM knowledge_entries WHERE workspace_id=w AND path=p->>'path' FOR UPDATE;
 IF old.id IS NULL OR NOT EXISTS(SELECT 1 FROM knowledge_repo_publication_heads h WHERE h.workspace_id=w AND h.entry_id=old.id)
  OR coalesce(p->>'operation','') NOT IN('','related') THEN
  RETURN QUERY SELECT * FROM apply_knowledge_source_sync(p,e);RETURN;
 END IF;
 IF old.source_id IS DISTINCT FROM s.id OR old.scope_held OR coalesce(p->>'sourceSha','')=''
  OR entity_derivation_envelope_valid(p||jsonb_build_object('userId',NULL,'assistantId',NULL)) IS NOT TRUE
  OR p->>'userId' IS NOT NULL OR p->>'assistantId' IS NOT NULL
  OR nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
  OR nullif(current_setting('app.v2_assistant_id',true),'') IS NOT NULL
  OR current_setting('app.system_bypass',true)='true'
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.knowledge_entries'::regclass WHERE r.rolname=session_user
   AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
  THEN RAISE EXCEPTION 'knowledge_repo_reconciliation_required' USING ERRCODE='42501';END IF;
 -- No caller-selected ceilings and no assistant/attended identity. Current
 -- membership remains independently enforced by every canonical native reader.
 FOR setting IN SELECT * FROM jsonb_each_text(jsonb_build_object(
  'app.agent_workspace_id',w::text,'app.agent_actor_id',actor::text,'app.agent_clearance',s.binding_sensitivity,
  'app.agent_compartments',to_jsonb(s.binding_compartments)::text,'app.agent_project_ids',to_jsonb(s.binding_project_ids)::text,
  'app.agent_mutation_compartments',to_jsonb(s.binding_compartments)::text,
  'app.agent_shared_audience','true','app.agent_visibility_assistants','[]')) LOOP
  saved:=saved||jsonb_build_object(setting.key,current_setting(setting.key,true));
  PERFORM set_config(setting.key,setting.value,true);
 END LOOP;
 IF sensitivity_rank(p->>'sensitivity')<sensitivity_rank(old.sensitivity)
  OR NOT(p->'compartments')@>to_jsonb(old.compartments) OR NOT(p->'projectIds')@>to_jsonb(old.project_ids)
  OR member_operation_scope_allows(w,p->>'sensitivity',ARRAY(SELECT jsonb_array_elements_text(p->'compartments')),true) IS NOT TRUE
  OR agent_mutation_scope_allows(ARRAY(SELECT jsonb_array_elements_text(p->'compartments'))) IS NOT TRUE
  OR agent_read_scope_allows(p->>'sensitivity',ARRAY(SELECT jsonb_array_elements_text(p->'compartments')),ARRAY(SELECT jsonb_array_elements_text(p->'projectIds')::uuid)) IS NOT TRUE
  OR native_knowledge_version_fields_allowed(w,old.id,application_knowledge_field_keys()) IS NOT TRUE
  THEN RAISE EXCEPTION 'knowledge_repo_reconciliation_required' USING ERRCODE='42501';END IF;
 -- Walk exact immutable observations. Unsupported kinds and all external
 -- dependencies hold before capture/archive or changing the mutable head.
 FOR node IN SELECT * FROM application_scope_lineage(w,ARRAY['knowledge_entry'],ARRAY[old.id],ARRAY[old.scope_version::text]) LOOP
  IF node.kind NOT IN('knowledge_entry','knowledge_entry_revision','knowledge_source','application_field','application_query_domain')
   THEN RAISE EXCEPTION 'knowledge_repo_reconciliation_required' USING ERRCODE='42501';END IF;
  IF node.kind='application_field' THEN
   current:=read_admitted_application_field_snapshot(w,node.id,node.version);
  ELSIF node.kind='application_query_domain' THEN
   -- A query domain is admitted through its complete recorded field observation.
   IF NOT EXISTS(SELECT 1 FROM application_field_resources f JOIN application_field_observations o
    ON o.workspace_id=f.workspace_id AND o.resource_id=f.id
    WHERE f.workspace_id=w AND f.resource_id=node.id AND f.selection='query_domain'
     AND EXISTS(SELECT 1 FROM application_scope_lineage(w,ARRAY['knowledge_entry'],ARRAY[old.id],ARRAY[old.scope_version::text]) l
      WHERE l.kind='application_field' AND l.id=f.id AND l.version=o.version)) THEN
    RAISE EXCEPTION 'knowledge_repo_reconciliation_required' USING ERRCODE='42501';END IF;
   CONTINUE;
  ELSIF node.kind='knowledge_entry' THEN
   current:=read_entity_derivation_source(w,node.kind,node.id);
   IF current->>'version' IS DISTINCT FROM node.version THEN
    current:=knowledge_version_field_state(w,node.id,node.version,'{}');
    IF current IS NULL OR current->>'recordVersion' IS DISTINCT FROM node.version THEN RAISE EXCEPTION 'knowledge_repo_reconciliation_required' USING ERRCODE='42501';END IF;
    CONTINUE;
   END IF;
  ELSE current:=read_entity_derivation_source(w,node.kind,node.id);END IF;
  IF current IS NULL OR current->>'held' IS DISTINCT FROM 'false' OR current->>'version' IS DISTINCT FROM node.version
   THEN RAISE EXCEPTION 'knowledge_repo_reconciliation_required' USING ERRCODE='42501';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM read_external_source_dependencies(w,ARRAY['knowledge_entry'],ARRAY[old.id],ARRAY[old.scope_version::text]))
  OR application_canonical_ancestry_allowed(w,'knowledge_entry',old.id,old.scope_version::text,true) IS NOT TRUE
  THEN RAISE EXCEPTION 'knowledge_repo_reconciliation_required' USING ERRCODE='42501';END IF;
 context:=application_knowledge_query_context(w);
 IF context IS NULL THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 fields:=CASE WHEN p->>'operation'='related' THEN ARRAY['relatedIds'] ELSE ARRAY['content','title','summary','tags','metadata'] END;
 IF context#>>'{policy,nativeDefault}' IS DISTINCT FROM 'true' THEN
  catalog:=read_native_application_field_catalog(w,'{"kind":"native","moduleKey":"native"}','knowledge_entry');
  mask:=read_native_application_field_mask(w,'{"kind":"native","moduleKey":"native"}','knowledge_entry',old.id::text,old.scope_version::text);
  FOREACH field IN ARRAY fields LOOP
   IF catalog IS NULL OR mask IS NULL OR NOT coalesce(catalog->'writeFields' ? field,false)
    OR NOT coalesce(mask->'writeFields' ? field,false) THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
  END LOOP;
 END IF;
 IF p->>'operation'='related' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(p->'relatedIds') r(id) WHERE NOT EXISTS(
  SELECT 1 FROM knowledge_entries k WHERE k.id=r.id::uuid AND k.workspace_id=w AND NOT k.scope_held
   AND sensitivity_rank(k.sensitivity)<=sensitivity_rank(old.sensitivity) AND k.compartments<@old.compartments AND k.project_ids<@old.project_ids))
  THEN RAISE EXCEPTION 'knowledge_source_target_conflict';END IF;
 IF p->>'operation'='related' AND to_jsonb(old.related_ids)=p->'relatedIds'
  OR coalesce(p->>'operation','')='' AND (old.title,old.summary,old.content,to_jsonb(old.tags),old.sensitivity,old.sensitivity_explicit,old.metadata,old.source_sha,to_jsonb(old.compartments),to_jsonb(old.project_ids))
    IS NOT DISTINCT FROM (p->>'title',p->>'summary',p->>'content',coalesce(p->'tags','[]'),p->>'sensitivity',(p->>'sensitivityExplicit')::boolean,coalesce(p->'metadata','{}'),p->>'sourceSha',p->'compartments',p->'projectIds') THEN
  FOR setting IN SELECT * FROM jsonb_each_text(saved) LOOP PERFORM set_config(setting.key,coalesce(setting.value,''),true);END LOOP;
  RETURN NEXT old;RETURN;
 END IF;
 prior_revision:=capture_native_knowledge_version(w,old.id,old.scope_version::text,application_knowledge_field_keys());
 IF prior_revision IS NULL THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 PERFORM archive_native_knowledge_version(w,old.id,old.scope_version::text,prior_revision);
 -- A newly captured prior root must pair while its version is still current.
 -- New body publication is created only after these queued checks are complete.
 SET CONSTRAINTS knowledge_scope_revision_pair,knowledge_revision_publication_pair IMMEDIATE;
 SET CONSTRAINTS knowledge_scope_revision_pair,knowledge_revision_publication_pair DEFERRED;
 INSERT INTO knowledge_entry_scope_revisions(workspace_id,entry_id,sensitivity,compartments,project_ids,revision_kind)
  VALUES(w,old.id,p->>'sensitivity',ARRAY(SELECT jsonb_array_elements_text(p->'compartments')),ARRAY(SELECT jsonb_array_elements_text(p->'projectIds')::uuid),'body') RETURNING id INTO next_revision;
 INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
  SELECT w,'knowledge_entry_revision',next_revision,'1','knowledge-source-reconciliation',NULL,NULL,p->>'sensitivity',
   ARRAY(SELECT jsonb_array_elements_text(p->'compartments')),ARRAY(SELECT jsonb_array_elements_text(p->'projectIds')::uuid),revision
  FROM workspace_access_policies WHERE workspace_id=w RETURNING id INTO derivation;
 INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version) VALUES
  (w,derivation,'knowledge_entry_revision',prior_revision,'1'),(w,derivation,'knowledge_source',s.id,s.binding_version::text);
 -- Canonical field validation requires exact direct witnesses as well as the
 -- complete immutable root. Reuse original identities/versions; never observe anew.
 INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
  SELECT DISTINCT w,derivation,'application_field',(dependency.source->>'resourceId')::uuid,dependency.node_version
  FROM read_application_field_dependencies(w,ARRAY['knowledge_entry'],ARRAY[old.id],ARRAY[old.scope_version::text]) dependency;
 SET CONSTRAINTS application_field_derivation_dependencies,page_derivation_dependencies,workflow_derivation_dependencies IMMEDIATE;
 SET CONSTRAINTS application_field_derivation_dependencies,page_derivation_dependencies,workflow_derivation_dependencies DEFERRED;
 IF p->>'operation'='related' THEN
  UPDATE knowledge_entries SET related_ids=ARRAY(SELECT jsonb_array_elements_text(p->'relatedIds')::uuid) WHERE id=old.id RETURNING * INTO output;
 ELSE
  UPDATE knowledge_entries SET title=p->>'title',summary=p->>'summary',content=p->>'content',tags=ARRAY(SELECT jsonb_array_elements_text(p->'tags')),
   sensitivity=p->>'sensitivity',sensitivity_explicit=(p->>'sensitivityExplicit')::boolean,metadata=coalesce(p->'metadata','{}'),
   source_sha=p->>'sourceSha',compartments=ARRAY(SELECT jsonb_array_elements_text(p->'compartments')),project_ids=ARRAY(SELECT jsonb_array_elements_text(p->'projectIds')::uuid)
   WHERE id=old.id AND scope_version=old.scope_version RETURNING * INTO output;
 END IF;
 PERFORM publish_native_knowledge_body_revision(w,old.id,output.scope_version::text,next_revision);
 INSERT INTO knowledge_repo_publication_heads VALUES(w,old.id,output.scope_version::text);
 SET CONSTRAINTS application_field_derivation_dependencies,page_derivation_dependencies,workflow_derivation_dependencies IMMEDIATE;
 SET CONSTRAINTS application_field_derivation_dependencies,page_derivation_dependencies,workflow_derivation_dependencies DEFERRED;
 FOR setting IN SELECT * FROM jsonb_each_text(saved) LOOP PERFORM set_config(setting.key,coalesce(setting.value,''),true);END LOOP;
 RETURN NEXT output;
END $$;
REVOKE ALL ON FUNCTION apply_knowledge_source_refresh(jsonb,jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION apply_knowledge_source_refresh(jsonb,jsonb) TO app_user;
END IF;END $$;
