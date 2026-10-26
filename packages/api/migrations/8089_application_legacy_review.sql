-- Metadata-only application recovery on the existing immutable review lifecycle.
-- [COMP:api/application-legacy-review]
BEGIN;
ALTER TABLE workspace_scope_reviews ADD COLUMN application_assistant_id uuid REFERENCES assistants(id);
ALTER TABLE workspace_scope_review_items ADD COLUMN application_replacement_id uuid;

CREATE FUNCTION guard_application_legacy_review_metadata() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='workspace_scope_reviews' THEN
  IF NEW.application_assistant_id IS DISTINCT FROM OLD.application_assistant_id THEN RAISE EXCEPTION 'scope_review_proposal_immutable' USING ERRCODE='22023'; END IF;
 ELSE
  IF OLD.application_replacement_id IS NOT NULL AND NEW.application_replacement_id IS DISTINCT FROM OLD.application_replacement_id THEN RAISE EXCEPTION 'scope_review_proposal_immutable' USING ERRCODE='22023'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_application_legacy_review_metadata() FROM PUBLIC;
CREATE TRIGGER application_legacy_review_metadata BEFORE UPDATE ON workspace_scope_reviews
 FOR EACH ROW EXECUTE FUNCTION guard_application_legacy_review_metadata();
CREATE TRIGGER application_legacy_review_item_metadata BEFORE UPDATE ON workspace_scope_review_items
 FOR EACH ROW EXECUTE FUNCTION guard_application_legacy_review_metadata();

CREATE FUNCTION application_legacy_review_authorize(w uuid,acting uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.workspace_scope_reviews'::regclass
   WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
  OR application_governance_allows(w) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 PERFORM id FROM workspaces WHERE id=w FOR UPDATE;
 PERFORM user_id FROM workspace_members WHERE workspace_id=w AND user_id=actor AND role IN('owner','admin') FOR SHARE;
 IF NOT FOUND OR acting IS NULL OR assistant_placement_visible(actor,acting) IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM assistants WHERE id=acting AND workspace_id=w)
  OR nullif(current_setting('app.v2_assistant_id',true),'') IS DISTINCT FROM acting::text
  THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;
REVOKE ALL ON FUNCTION application_legacy_review_authorize(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION application_legacy_inventory_registry() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT ARRAY['memory','entity','entity_link','task','workspace_file','episode','knowledge_entry','kb_chunk',
 'crm_event','memory_verification','brain_verification','correction_audit','session_message','feedback_event',
 'workspace_skill_revision','file_cache','file_segment','recording','transcript_segment','entity_instance','blueprint_record','office_artifact']
$$;
REVOKE ALL ON FUNCTION application_legacy_inventory_registry() FROM PUBLIC;

CREATE FUNCTION application_legacy_review_snapshot(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT k=ANY(application_legacy_inventory_registry()) OR read_scope_review_source(w,k,i) IS NULL THEN RETURN NULL; END IF;
 EXECUTE format('SELECT id FROM %I WHERE id=$1 FOR UPDATE',scope_review_source_table(k)) USING i;
 RETURN read_scope_review_source(w,k,i);
END $$;
REVOKE ALL ON FUNCTION application_legacy_review_snapshot(uuid,text,uuid) FROM PUBLIC;

-- Freeze the same semantic descendant graph used by canonical invalidation.
-- Unregistered descendants cannot be certified by an empty impact.
CREATE FUNCTION application_legacy_review_impact(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE node record; current_value jsonb; descendants jsonb:='[]';
BEGIN
 IF scope_source_table(k) IS NULL THEN RETURN jsonb_build_object('version',2,'descendants','[]'::jsonb,'dependents','{}'::jsonb);END IF;
 FOR node IN SELECT * FROM scope_descendant_resources(w,k,i) ORDER BY resource_kind,resource_id LIMIT 501 LOOP
  IF jsonb_array_length(descendants)>=500 THEN RAISE EXCEPTION 'invalid_value: review impact exceeds 500' USING ERRCODE='22023';END IF;
  current_value:=application_legacy_review_snapshot(w,node.resource_kind,node.resource_id);
  IF current_value IS NULL THEN RAISE EXCEPTION 'access_unavailable: unsupported descendant' USING ERRCODE='42501';END IF;
  descendants:=descendants||jsonb_build_array(jsonb_build_object('resourceKind',node.resource_kind,'resourceId',node.resource_id,
    'version',current_value->>'version','held',(current_value->>'held')::boolean));
 END LOOP;
 RETURN jsonb_build_object('version',2,'descendants',descendants,'dependents','{}'::jsonb);
END $$;
REVOKE ALL ON FUNCTION application_legacy_review_impact(uuid,text,uuid) FROM PUBLIC;

-- A release never certifies unknown or changed ancestry. Only unchanged native
-- inputs that the actual reviewer can independently read are supported here.
CREATE FUNCTION application_legacy_repair_plan(w uuid,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE m memories; actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 node record; snapshot jsonb; heads jsonb:='[]'; n integer:=0;
BEGIN
 SELECT * INTO m FROM memories WHERE workspace_id=w AND id=i FOR UPDATE;
 IF NOT FOUND OR NOT m.scope_held OR m.valid_to IS NOT NULL OR m.retracted_at IS NOT NULL
  OR m.created_by_user_id IS DISTINCT FROM actor OR m.user_id IS NOT NULL AND m.user_id<>actor
  OR NOT agent_visibility_allows(w,m.user_id,m.assistant_id)
  OR workflow_evidence_envelope_visible(w,jsonb_build_object('workspaceId',w,'userId',m.user_id,'assistantId',m.assistant_id,
    'sensitivity',m.sensitivity,'compartments',m.compartments,'projectIds',m.project_ids)) IS NOT TRUE
  OR EXISTS(SELECT 1 FROM workspace_scope_review_items it JOIN workspace_scope_reviews r ON r.id=it.review_id AND r.workspace_id=it.workspace_id
    WHERE it.workspace_id=w AND it.resource_kind='memory' AND it.resource_id=i AND it.status='applied' AND r.action='hold')
  OR EXISTS(SELECT 1 FROM scope_resource_states WHERE workspace_id=w AND resource_kind='memory' AND resource_id=i
    AND review_state='held' AND holding_reason='administrator_review') THEN RETURN NULL; END IF;
 -- Walk the entire immutable closure, including ancestry beyond the direct inputs.
 FOR node IN SELECT * FROM application_scope_lineage(w,ARRAY['memory'],ARRAY[i],ARRAY[m.scope_version::text]) LOOP
  IF node.kind='memory' AND node.id=i THEN CONTINUE; END IF;
  IF node.kind NOT IN('memory','entity','entity_link','task','workspace_file','episode','knowledge_entry','kb_chunk') THEN RETURN NULL; END IF;
  snapshot:=read_entity_derivation_source(w,node.kind,node.id);
  IF snapshot IS NULL OR snapshot->>'version' IS DISTINCT FROM node.version OR snapshot->>'held' IS DISTINCT FROM 'false'
   OR snapshot->>'validTo' IS NOT NULL OR snapshot->>'retractedAt' IS NOT NULL THEN RETURN NULL; END IF;
  n:=n+1;IF n>100 THEN RETURN NULL;END IF;
 END LOOP;
 FOR node IN SELECT s.source_kind AS kind,s.source_id AS id,s.source_version AS version
  FROM scope_derivations d JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
  WHERE d.workspace_id=w AND d.resource_kind='memory' AND d.resource_id=i AND d.resource_version=m.scope_version::text
  ORDER BY s.source_kind,s.source_id LOOP
  snapshot:=read_entity_derivation_source(w,node.kind,node.id);
  IF snapshot IS NULL OR snapshot->>'version' IS DISTINCT FROM node.version OR snapshot->>'held' IS DISTINCT FROM 'false'
   OR snapshot->>'validTo' IS NOT NULL OR snapshot->>'retractedAt' IS NOT NULL
   OR snapshot->>'userId' IS NOT NULL AND snapshot->>'userId' IS DISTINCT FROM m.user_id::text
   OR snapshot->>'assistantId' IS NOT NULL AND snapshot->>'assistantId' IS DISTINCT FROM m.assistant_id::text
   OR sensitivity_rank(m.sensitivity)<sensitivity_rank(snapshot->>'sensitivity')
   OR NOT (to_jsonb(m.compartments) @> (snapshot->'compartments')) OR NOT (to_jsonb(m.project_ids) @> (snapshot->'projectIds'))
   THEN RETURN NULL; END IF;
  heads:=heads||jsonb_build_array(snapshot);
  IF jsonb_array_length(heads)>100 THEN RETURN NULL; END IF;
 END LOOP;
 IF jsonb_array_length(heads)=0 THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('version',1,'heads',heads);
EXCEPTION WHEN invalid_parameter_value OR invalid_text_representation OR insufficient_privilege THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_legacy_repair_plan(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION application_legacy_inventory(w uuid,acting uuid,k text,after_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid; ids uuid[]; i uuid; snapshot jsonb; items jsonb:='[]'; next_id uuid;
 families jsonb; state_revision text; total bigint;
BEGIN
 actor:=application_legacy_review_authorize(w,acting);
 IF NOT k=ANY(application_legacy_inventory_registry()) THEN RAISE EXCEPTION 'invalid_value' USING ERRCODE='22023'; END IF;
 IF k='session_message' THEN
  SELECT array_agg(id ORDER BY id) INTO ids FROM (SELECT r.id FROM session_messages r JOIN sessions s ON s.id=r.session_id
   WHERE coalesce(r.workspace_id,s.workspace_id)=w AND (after_id IS NULL OR r.id>after_id) ORDER BY r.id LIMIT 101) p;
 ELSIF k='feedback_event' THEN
  SELECT array_agg(id ORDER BY id) INTO ids FROM (SELECT r.id FROM analytics_events r LEFT JOIN assistants a ON a.id=r.assistant_id
   WHERE coalesce(r.workspace_id,a.workspace_id)=w AND r.event_name='feedback_negative' AND (after_id IS NULL OR r.id>after_id) ORDER BY r.id LIMIT 101) p;
 ELSE
  EXECUTE format('SELECT array_agg(id ORDER BY id) FROM (SELECT id FROM %I WHERE workspace_id=$1 AND ($2 IS NULL OR id>$2) ORDER BY id LIMIT 101) p',scope_review_source_table(k)) INTO ids USING w,after_id;
 END IF;
 FOREACH i IN ARRAY coalesce(ids,'{}') LOOP
  IF jsonb_array_length(items)=100 THEN next_id:=(items->-1->>'id')::uuid;EXIT;END IF;
  snapshot:=read_scope_review_source(w,k,i);
  IF snapshot IS NOT NULL THEN items:=items||jsonb_build_array(jsonb_build_object('id',i,'version',snapshot->>'version','held',snapshot->'held',
    'sensitivity',snapshot->'sensitivity','compartments',snapshot->'compartments','projectIds',snapshot->'projectIds',
    'allowedActions',CASE WHEN k='memory' AND application_legacy_repair_plan(w,i) IS NOT NULL THEN ARRAY['hold','release'] ELSE ARRAY['hold'] END));END IF;
 END LOOP;
 -- Additional persistent families are counted without adopting historical bytes.
 SELECT jsonb_build_array(
  jsonb_build_object('family','session_context_revision','total',(SELECT count(*)::text FROM session_context_scope_revisions WHERE workspace_id=w),
    'unresolved',(SELECT count(*)::text FROM session_context_scope_revisions r WHERE r.workspace_id=w AND (r.scope_held OR NOT EXISTS(SELECT 1 FROM session_context_revision_contents c WHERE c.revision_id=r.id)))),
  jsonb_build_object('family','legacy_compact_summary','total',(SELECT count(*)::text FROM sessions WHERE workspace_id=w AND compact_summary IS NOT NULL),
    'unresolved',(SELECT count(*)::text FROM sessions WHERE workspace_id=w AND compact_summary IS NOT NULL AND compact_scope_revision_id IS NULL)),
  jsonb_build_object('family','legacy_session_state','total',(SELECT count(*)::text FROM session_state r JOIN sessions s ON s.id=r.session_id WHERE s.workspace_id=w),
    'unresolved',(SELECT count(*)::text FROM session_state r JOIN sessions s ON s.id=r.session_id WHERE s.workspace_id=w AND r.scope_revision_id IS NULL)),
  jsonb_build_object('family','legacy_episodic_memory','total',(SELECT count(*)::text FROM episodic_memories r JOIN sessions s ON s.id=r.session_id WHERE s.workspace_id=w),
    'unresolved',(SELECT count(*)::text FROM episodic_memories r JOIN sessions s ON s.id=r.session_id WHERE s.workspace_id=w AND r.scope_revision_id IS NULL)),
  jsonb_build_object('family','application_field','total',(SELECT count(*)::text FROM application_field_resources WHERE workspace_id=w),
    'unresolved',(SELECT count(*)::text FROM application_field_resources r WHERE r.workspace_id=w AND NOT EXISTS(SELECT 1 FROM application_field_observations o WHERE o.workspace_id=w AND o.resource_id=r.id))),
  jsonb_build_object('family','external_source','total',(SELECT count(*)::text FROM external_source_resources WHERE workspace_id=w),
    'unresolved',(SELECT count(*)::text FROM external_source_resources r WHERE r.workspace_id=w AND (r.state<>'active' OR NOT EXISTS(SELECT 1 FROM external_source_observations o WHERE o.workspace_id=w AND o.resource_id=r.id))))
 ) INTO families;
 SELECT revision::text INTO state_revision FROM workspace_access_policies WHERE workspace_id=w;
 RETURN jsonb_build_object('resourceKind',k,'items',items,'nextCursor',next_id,'supportedKinds',application_legacy_inventory_registry(),
  'registryRevision','3','policyRevision',coalesce(state_revision,'1'),'validForMs',30000,'additionalFamilies',families,
  'completeCoverage',false,'qualification','consumer_qualification_incomplete');
END $$;
REVOKE ALL ON FUNCTION application_legacy_inventory(uuid,uuid,text,uuid) FROM PUBLIC;

CREATE FUNCTION application_legacy_review_view(w uuid,acting uuid,target_review uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid; review workspace_scope_reviews; items jsonb;
BEGIN
 actor:=application_legacy_review_authorize(w,acting);
 SELECT * INTO review FROM workspace_scope_reviews WHERE workspace_id=w AND id=target_review AND created_by=actor AND application_assistant_id=acting;
 IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('resourceId',resource_id,'resourceVersion',resource_version,'status',status,
  'resultVersion',result_version,'replacementId',application_replacement_id,'errorCode',error_code) ORDER BY resource_id),'[]') INTO items
 FROM workspace_scope_review_items WHERE workspace_id=w AND review_id=review.id;
 RETURN jsonb_build_object('id',review.id,'resourceKind',review.resource_kind,'action',review.action,'version',review.version::text,
  'status',review.status,'payloadHash',review.payload_hash,'items',items,'validForMs',30000);
END $$;
REVOKE ALL ON FUNCTION application_legacy_review_view(uuid,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION application_legacy_review_preview(w uuid,acting uuid,k text,ids uuid[],operation text,reason_value text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid; i uuid; snapshot jsonb; snapshots jsonb:='[]'; repairs jsonb:='[]'; repair jsonb; impacts jsonb:='[]'; impact jsonb;
 revision_value bigint; review_id uuid:=gen_random_uuid(); digest_value text; pos integer:=0;
BEGIN
 actor:=application_legacy_review_authorize(w,acting);
 IF NOT k=ANY(application_legacy_inventory_registry()) OR operation NOT IN('hold','release') OR operation='release' AND k<>'memory'
  OR cardinality(ids) NOT BETWEEN 1 AND 100 OR array_position(ids,NULL) IS NOT NULL
  OR (SELECT count(*)<>count(DISTINCT x) FROM unnest(ids) x) OR length(btrim(reason_value)) NOT BETWEEN 1 AND 1000
  THEN RAISE EXCEPTION 'invalid_value' USING ERRCODE='22023';END IF;
 INSERT INTO workspace_access_policies(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;
 SELECT revision INTO revision_value FROM workspace_access_policies WHERE workspace_id=w FOR UPDATE;
 FOREACH i IN ARRAY ARRAY(SELECT unnest(ids) ORDER BY 1) LOOP
  snapshot:=application_legacy_review_snapshot(w,k,i);
  IF snapshot IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  repair:=CASE WHEN operation='release' THEN application_legacy_repair_plan(w,i) ELSE 'null'::jsonb END;
  IF operation='release' AND repair IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  impact:=CASE WHEN operation='hold' THEN application_legacy_review_impact(w,k,i) ELSE jsonb_build_object('version',2,'descendants','[]'::jsonb,'dependents','{}'::jsonb) END;
  snapshots:=snapshots||jsonb_build_array(snapshot);repairs:=repairs||jsonb_build_array(repair);impacts:=impacts||jsonb_build_array(impact);
 END LOOP;
 digest_value:=application_field_digest(jsonb_build_object('workspaceId',w,'actorId',actor,'assistantId',acting,'registryRevision','3',
  'policyRevision',revision_value,'kind',k,'action',operation,'reason',reason_value,'snapshots',snapshots,'repairs',repairs,'impacts',impacts));
 INSERT INTO workspace_scope_reviews(id,workspace_id,created_by,resource_kind,action,reason,payload_hash,policy_revision,selection_revision,application_assistant_id)
  VALUES(review_id,w,actor,k,operation,reason_value,digest_value,revision_value,revision_value,acting);
 FOR pos IN 0..jsonb_array_length(snapshots)-1 LOOP
  snapshot:=snapshots->pos;
  INSERT INTO workspace_scope_review_items(workspace_id,review_id,resource_kind,resource_id,resource_version,source_snapshot,impact_snapshot)
   VALUES(w,review_id,k,(snapshot->>'resourceId')::uuid,snapshot->>'version',snapshot,
    (impacts->pos)||jsonb_build_object('applicationRepair',repairs->pos));
 END LOOP;
 INSERT INTO workspace_access_events(workspace_id,actor_user_id,kind,subject_id,policy_revision,changes)
  VALUES(w,actor,'application.legacy.preview',review_id,revision_value,jsonb_build_object('action',operation,'count',cardinality(ids),'payloadHash',digest_value));
 RETURN application_legacy_review_view(w,acting,review_id);
END $$;
REVOKE ALL ON FUNCTION application_legacy_review_preview(uuid,uuid,text,uuid[],text,text) FROM PUBLIC;

CREATE FUNCTION application_legacy_review_apply(w uuid,acting uuid,target_review uuid,expected text,payload text,cancel_value boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid; review workspace_scope_reviews; item workspace_scope_review_items; snapshot jsonb; repair jsonb;
 revision_value bigint; stale_value boolean:=false; replacement memories; original memories; d uuid; input jsonb; applied_count integer:=0;
BEGIN
 actor:=application_legacy_review_authorize(w,acting);
 SELECT * INTO review FROM workspace_scope_reviews WHERE workspace_id=w AND id=target_review AND created_by=actor AND application_assistant_id=acting FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 IF expected !~ '^[1-9][0-9]*$' OR payload IS DISTINCT FROM review.payload_hash OR expected::numeric>review.version THEN
  RAISE EXCEPTION 'record_version_conflict' USING ERRCODE='40001';END IF;
 IF expected::numeric<review.version OR review.status IN('complete','stale','cancelled') THEN RETURN application_legacy_review_view(w,acting,review.id);END IF;
 IF cancel_value THEN
  UPDATE workspace_scope_review_items SET status='cancelled' WHERE workspace_id=w AND review_id=review.id AND status='pending';
  UPDATE workspace_scope_reviews SET status='cancelled',version=version+1,updated_at=now() WHERE id=review.id;
  INSERT INTO workspace_access_events(workspace_id,actor_user_id,kind,subject_id,policy_revision,changes)
   SELECT w,actor,'application.legacy.cancel',review.id,revision,jsonb_build_object('payloadHash',payload) FROM workspace_access_policies WHERE workspace_id=w;
  RETURN application_legacy_review_view(w,acting,review.id);
 END IF;
 SELECT revision INTO revision_value FROM workspace_access_policies WHERE workspace_id=w FOR UPDATE;
 stale_value:=revision_value IS DISTINCT FROM review.policy_revision;
 FOR item IN SELECT * FROM workspace_scope_review_items WHERE workspace_id=w AND review_id=review.id AND status='pending' ORDER BY resource_id LOOP
  snapshot:=application_legacy_review_snapshot(w,review.resource_kind,item.resource_id);
  IF snapshot IS DISTINCT FROM item.source_snapshot THEN stale_value:=true;END IF;
  IF review.action='hold' AND application_legacy_review_impact(w,item.resource_kind,item.resource_id) IS DISTINCT FROM item.impact_snapshot-'applicationRepair' THEN stale_value:=true;END IF;
  IF review.action='release' AND application_legacy_repair_plan(w,item.resource_id) IS DISTINCT FROM item.impact_snapshot->'applicationRepair' THEN stale_value:=true;END IF;
 END LOOP;
 IF stale_value THEN
  UPDATE workspace_scope_review_items SET status='stale',error_code='scope_review_changed' WHERE workspace_id=w AND review_id=review.id AND status='pending';
  UPDATE workspace_scope_reviews SET status='stale',version=version+1,updated_at=now() WHERE id=review.id;
  RETURN application_legacy_review_view(w,acting,review.id);
 END IF;
 PERFORM set_config('app.scope_review_actor',actor::text,true);
 FOR item IN SELECT * FROM workspace_scope_review_items WHERE workspace_id=w AND review_id=review.id AND status='pending' ORDER BY resource_id LIMIT 25 LOOP
  IF review.action='hold' THEN
   IF item.resource_kind IN('memory','entity','entity_link','task','workspace_file','episode','knowledge_entry','kb_chunk','workspace_skill_revision','crm_event','memory_verification','brain_verification','correction_audit') THEN
    EXECUTE format('UPDATE %I SET scope_held=true WHERE workspace_id=$1 AND id=$2',scope_review_source_table(item.resource_kind)) USING w,item.resource_id;
    PERFORM hold_scope_descendants(w,item.resource_kind,item.resource_id);
   END IF;
   snapshot:=application_legacy_review_snapshot(w,item.resource_kind,item.resource_id);
   INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
    VALUES(w,item.resource_kind,item.resource_id,snapshot->>'version','held',revision_value,'administrator_review')
    ON CONFLICT(workspace_id,resource_kind,resource_id,resource_version) DO UPDATE SET review_state='held',holding_reason='administrator_review',updated_at=now();
   UPDATE workspace_scope_review_items SET status='applied',result_version=snapshot->>'version' WHERE workspace_id=w AND review_id=review.id AND resource_id=item.resource_id;
  ELSE
   -- Recompute inside this same write transaction, then copy using the canonical
   -- replacement shape. No protected bytes cross this metadata-only SQL boundary.
   repair:=application_legacy_repair_plan(w,item.resource_id);
   IF repair IS DISTINCT FROM item.impact_snapshot->'applicationRepair' THEN RAISE EXCEPTION 'record_version_conflict' USING ERRCODE='40001';END IF;
   SELECT * INTO original FROM memories WHERE workspace_id=w AND id=item.resource_id FOR UPDATE;
   INSERT INTO memories(assistant_id,user_id,app_id,workspace_id,scope,tags,summary,detail,confidence,sensitivity,source,source_session_id,
    created_by_user_id,created_by_assistant_id,source_episode_id,verified_by_user_id,verified_at,original_scope,original_sensitivity,original_summary,compartments,project_ids,valid_from)
    SELECT assistant_id,user_id,app_id,workspace_id,scope,tags,summary,detail,confidence,sensitivity,source,source_session_id,
     created_by_user_id,created_by_assistant_id,source_episode_id,verified_by_user_id,verified_at,original_scope,original_sensitivity,original_summary,compartments,project_ids,now()
    FROM memories WHERE workspace_id=w AND id=item.resource_id RETURNING * INTO replacement;
   INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
    VALUES(w,'memory',replacement.id,replacement.scope_version::text,'scope-review:release',replacement.user_id,replacement.assistant_id,replacement.sensitivity,replacement.compartments,replacement.project_ids,revision_value) RETURNING id INTO d;
   FOR input IN SELECT value FROM jsonb_array_elements(repair->'heads') LOOP
    INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
     VALUES(w,d,input->>'resourceKind',(input->>'resourceId')::uuid,input->>'version');
   END LOOP;
   UPDATE memories SET valid_to=now(),superseded_by=replacement.id,updated_at=now() WHERE workspace_id=w AND id=item.resource_id;
   UPDATE workspace_scope_review_items SET status='applied',result_version=replacement.scope_version::text,application_replacement_id=replacement.id
    WHERE workspace_id=w AND review_id=review.id AND resource_id=item.resource_id;
  END IF;
  applied_count:=applied_count+1;
 END LOOP;
 UPDATE workspace_access_policies SET revision=revision+1,updated_at=now() WHERE workspace_id=w RETURNING revision INTO revision_value;
 UPDATE workspace_scope_reviews SET version=version+1,policy_revision=revision_value,updated_at=now(),
  status=CASE WHEN EXISTS(SELECT 1 FROM workspace_scope_review_items WHERE workspace_id=w AND review_id=review.id AND status='pending') THEN 'running' ELSE 'complete' END WHERE id=review.id;
 INSERT INTO workspace_access_events(workspace_id,actor_user_id,kind,subject_id,policy_revision,changes)
  VALUES(w,actor,'application.legacy.apply',review.id,revision_value,jsonb_build_object('action',review.action,'count',applied_count,'payloadHash',payload));
 RETURN application_legacy_review_view(w,acting,review.id);
END $$;
REVOKE ALL ON FUNCTION application_legacy_review_apply(uuid,uuid,uuid,text,text,boolean) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  GRANT EXECUTE ON FUNCTION application_legacy_inventory(uuid,uuid,text,uuid),application_legacy_review_view(uuid,uuid,uuid),
   application_legacy_review_preview(uuid,uuid,text,uuid[],text,text),application_legacy_review_apply(uuid,uuid,uuid,text,text,boolean) TO app_user;
 END IF;
END $$;
COMMIT;
