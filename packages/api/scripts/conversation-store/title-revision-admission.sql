
DECLARE root jsonb;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 child_kinds text[];child_ids uuid[];child_versions text[];eligible boolean;position integer;admitted jsonb;dependency record;
 seen jsonb:='[]';current_source jsonb;chat_nodes jsonb;chat_proof jsonb;
BEGIN
 IF EXISTS(SELECT 1 FROM session_context_scope_revisions r WHERE r.workspace_id=w AND r.id=i AND r.parent_kind IN('turn_frame','session_title'))
  AND actor IS NOT NULL AND nullif(current_setting('app.application_id',true),'') IS NULL
  AND nullif(current_setting('app.public_share_root',true),'') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_roles login JOIN pg_class owned ON owned.oid='public.session_messages'::regclass
   WHERE login.rolname=session_user AND(login.rolsuper OR login.rolbypassrls OR pg_has_role(login.oid,owned.relowner,'USAGE'))) THEN
  chat_proof:=capture_conversation_evidence(w,jsonb_build_array(jsonb_build_object('kind','session_context_revision','id',i,'version','1')));
  IF chat_proof IS NOT NULL THEN RETURN (chat_proof->>'admitted'='true') IS TRUE;END IF;
  -- Page source family (8278 adapter): a closure the ordinary capture declines
  -- because it reaches a Page receipt is admitted for this principal only when
  -- the adapter proves it now and every source it names is visible to the
  -- current reader; anything else keeps the original evaluation below.
  chat_proof:=capture_page_closure_evidence(w,jsonb_build_array(jsonb_build_object('kind','session_context_revision','id',i,'version','1')),actor);
  IF chat_proof->>'admitted'='true' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(chat_proof->'immutable','[]')||coalesce(chat_proof->'current','[]')) c
   WHERE workflow_evidence_envelope_visible(w,c) IS NOT TRUE) THEN RETURN true;END IF;
 END IF;
 -- Recording privacy admission precedes body selection.
 IF NOT recording_source_read_allowed(w,'session_context_revision',i) THEN RETURN false;END IF;
 root:=read_entity_derivation_source(w,'session_context_revision',i);
 IF root IS NULL OR root->>'held' IS DISTINCT FROM 'false' THEN RETURN false;END IF;
 IF actor IS NOT NULL AND EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor)
  AND nullif(current_setting('app.application_id',true),'') IS NULL
  AND nullif(current_setting('app.public_share_root',true),'') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_roles login JOIN pg_class owned ON owned.oid='public.session_messages'::regclass WHERE login.rolname=session_user
    AND(login.rolsuper OR login.rolbypassrls OR pg_has_role(login.oid,owned.relowner,'USAGE'))) THEN

 SELECT array_agg(s.source_kind ORDER BY s.source_kind,s.source_id,s.source_version),
  array_agg(s.source_id ORDER BY s.source_kind,s.source_id,s.source_version),
  array_agg(s.source_version ORDER BY s.source_kind,s.source_id,s.source_version),
  count(*) BETWEEN 1 AND 100 AND bool_and(s.source_kind='application_field')
   AND bool_or(s.source_kind='application_field' AND EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=s.source_id
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history'))
 INTO child_kinds,child_ids,child_versions,eligible
 FROM session_context_scope_revisions r JOIN scope_derivations d ON d.workspace_id=r.workspace_id AND d.resource_kind='session_context_revision'
  AND d.resource_id=r.id AND d.resource_version='1' AND d.user_id IS NOT DISTINCT FROM r.user_id AND d.assistant_id IS NOT DISTINCT FROM r.assistant_id
  AND d.sensitivity=r.sensitivity AND d.compartments=r.compartments AND d.project_ids=r.project_ids
 JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
 WHERE r.workspace_id=w AND r.id=i AND r.parent_kind='session_title' AND r.parent_id=r.session_id AND r.scope_version=1;
 IF eligible IS TRUE AND EXISTS(SELECT 1 FROM application_scope_lineage(w,child_kinds,child_ids,child_versions) n WHERE n.kind='session_context_revision') THEN eligible:=false;END IF;

  IF eligible IS TRUE THEN
   IF root->>'version' IS DISTINCT FROM '1' OR application_reader_envelope_visible(w,root) IS NOT TRUE THEN RETURN false;END IF;
   FOR position IN 1..cardinality(child_ids) LOOP
    admitted:=read_admitted_application_field_snapshot(w,child_ids[position],child_versions[position]);
    IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' OR admitted->>'version' IS DISTINCT FROM child_versions[position] THEN RETURN false;END IF;
   END LOOP;
   FOR dependency IN SELECT * FROM read_native_session_field_dependencies(w,child_kinds,child_ids,child_versions) LOOP
    admitted:=read_admitted_application_field_snapshot(w,(dependency.source->>'resourceId')::uuid,dependency.node_version);
    IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' OR admitted->>'version' IS DISTINCT FROM dependency.node_version THEN RETURN false;END IF;
    seen:=seen||jsonb_build_array(jsonb_build_array(dependency.source->>'resourceId',dependency.node_version));
   END LOOP;
   IF jsonb_array_length(seen)=0 THEN RETURN false;END IF;
   FOR position IN 1..cardinality(child_ids) LOOP
    IF NOT seen @> jsonb_build_array(jsonb_build_array(child_ids[position]::text,child_versions[position])) THEN RETURN false;END IF;
   END LOOP;
   FOR dependency IN SELECT * FROM read_external_source_dependencies(w,child_kinds,child_ids,child_versions) LOOP
    current_source:=external_source_snapshot(w,(dependency.source->>'resourceId')::uuid);
    IF dependency.source IS NULL OR dependency.source->>'workspaceId' IS DISTINCT FROM w::text
     OR dependency.source->>'version' IS DISTINCT FROM dependency.node_version
     OR current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false'
     OR current_source->>'version' IS DISTINCT FROM dependency.node_version
     OR application_reader_envelope_visible(w,dependency.source) IS NOT TRUE
     OR application_reader_envelope_visible(w,current_source) IS NOT TRUE THEN RETURN false;END IF;
   END LOOP;
   RETURN true;
  END IF;
 END IF;
 -- Keep the separate historical-purpose branch above. Ordinary current
 -- Memory domains can use the existing complete cohort proof, never a label
 -- or an envelope supplied by the caller. Its explicit denial stays denied.
 IF actor IS NOT NULL AND EXISTS(SELECT 1 FROM workspace_members member WHERE member.workspace_id=w AND member.user_id=actor)
  AND nullif(current_setting('app.application_id',true),'') IS NULL
  AND nullif(current_setting('app.public_share_root',true),'') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_roles login JOIN pg_class owned ON owned.oid='public.session_messages'::regclass
   WHERE login.rolname=session_user AND(login.rolsuper OR login.rolbypassrls OR pg_has_role(login.oid,owned.relowner,'USAGE'))) THEN
  SELECT coalesce(jsonb_agg(to_jsonb(node)),'[]') INTO chat_nodes
   FROM application_scope_lineage(w,ARRAY['session_context_revision'],ARRAY[i],ARRAY['1']) node;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(chat_nodes) node
   JOIN application_field_resources resource ON resource.workspace_id=w AND resource.id=(node->>'id')::uuid
   WHERE node->>'kind'='application_field' AND resource.origin='{"kind":"native","moduleKey":"native"}'::jsonb
    AND resource.type_key='memory' AND resource.selection='query_domain')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(chat_nodes) node
    JOIN application_field_resources resource ON resource.workspace_id=w AND resource.id=(node->>'id')::uuid
    WHERE node->>'kind'='application_field' AND resource.type_key='memory'
     AND(resource.selection<>'query_domain' OR resource.selected_version IS NOT NULL)) THEN
   chat_proof:=read_native_session_cohort_evidence(w,ARRAY['session_context_revision'],ARRAY[i],ARRAY['1'],true);
   IF chat_proof IS NOT NULL THEN RETURN (chat_proof->>'admitted'='true') IS TRUE;END IF;
  END IF;
 END IF;
 RETURN root IS NOT NULL AND root->>'held'='false'
  AND application_canonical_ancestry_allowed(w,'session_context_revision',i,'1') IS TRUE;
END
