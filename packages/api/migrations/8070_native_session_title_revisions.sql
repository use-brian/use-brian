BEGIN;
-- [COMP:api/application-persistence] Immutable native session title evidence.
DO $review$ BEGIN
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.session_context_payload_shape(text,jsonb)'::regprocedure) IS DISTINCT FROM 'd9372fa543a5c89ac8ed787c24941df2360646086eb33ca144520483da769c78' THEN RAISE EXCEPTION 'Session title prerequisite changed: session_context_payload_shape(text,jsonb)';END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.session_context_revision_snapshot(uuid,uuid)'::regprocedure) IS DISTINCT FROM '8e1cbd4e1cddcfad62a53431a90de1f2ce3d5c9de6dfb94503fa5bb8de2eab56' THEN RAISE EXCEPTION 'Session title prerequisite changed: session_context_revision_snapshot(uuid,uuid)';END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.validate_session_context_revision_pair()'::regprocedure) IS DISTINCT FROM '4ee18b712e3f445bd32f57dfdecd5840ce07f2e605d0eb4808f9ffe3e934dc57' THEN RAISE EXCEPTION 'Session title prerequisite changed: validate_session_context_revision_pair()';END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.publish_native_session_context_revision(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer)'::regprocedure) IS DISTINCT FROM 'd355b0b7b78cee86f1b838d4f02c02cfc7ebc633a442ed187602feb96c1ad4e1' THEN RAISE EXCEPTION 'Session title prerequisite changed: publish_native_session_context_revision(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer)';END IF;
END $review$;
DO $kind$ DECLARE expression text;BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT expression FROM pg_constraint
  WHERE conrelid='session_context_scope_revisions'::regclass AND conname='session_context_scope_revisions_parent_kind_check';
 ALTER TABLE session_context_scope_revisions DROP CONSTRAINT session_context_scope_revisions_parent_kind_check;
 EXECUTE format('ALTER TABLE session_context_scope_revisions ADD CONSTRAINT session_context_scope_revisions_parent_kind_check CHECK((%s) OR parent_kind=%L)',expression,'session_title');
END $kind$;
CREATE TABLE session_title_heads (
 session_id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 scope_revision_id uuid NOT NULL,
 FOREIGN KEY(workspace_id,scope_revision_id) REFERENCES session_context_scope_revisions(workspace_id,id)
);
CREATE INDEX session_title_heads_workspace ON session_title_heads(workspace_id,session_id);
ALTER TABLE session_title_heads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON session_title_heads FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN REVOKE ALL ON session_title_heads FROM app_user;END IF;END $$;

CREATE OR REPLACE FUNCTION session_context_payload_shape(k text,p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE item text;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF k='session_title' THEN
  RETURN p ?& ARRAY['title','manual'] AND p-ARRAY['title','manual']='{}'::jsonb
   AND jsonb_typeof(p->'title')='string' AND length(btrim(p->>'title')) BETWEEN 1 AND 200
   AND jsonb_typeof(p->'manual')='boolean';
 ELSIF k='message_annotation' THEN
  RETURN p ?& ARRAY['topicLabel','topicConfidence','replyToText']
   AND p-ARRAY['topicLabel','topicConfidence','replyToText']='{}'::jsonb
   AND jsonb_typeof(p->'topicLabel')='string' AND length(p->>'topicLabel') BETWEEN 1 AND 200
   AND jsonb_typeof(p->'topicConfidence')='number'
   AND (p->>'topicConfidence')::numeric BETWEEN 0 AND 1
   AND jsonb_typeof(p->'replyToText') IN('string','null')
   AND (jsonb_typeof(p->'replyToText')='null' OR length(p->>'replyToText')<=8000);
 ELSIF k='compact_summary' THEN
  RETURN p ?& ARRAY['summary','boundarySequence'] AND p-ARRAY['summary','boundarySequence']='{}'::jsonb
   AND jsonb_typeof(p->'summary')='string' AND length(p->>'summary')>0
   AND jsonb_typeof(p->'boundarySequence')='number' AND (p->>'boundarySequence')::numeric>=0
   AND trunc((p->>'boundarySequence')::numeric)=(p->>'boundarySequence')::numeric;
 ELSIF k='session_state' THEN
  RETURN p ?& ARRAY['key','status','summary','detail','source','createdAt','updatedAt','resolvedAt']
   AND p-ARRAY['key','status','summary','detail','source','createdAt','updatedAt','resolvedAt']='{}'::jsonb
   AND jsonb_typeof(p->'key')='string' AND length(p->>'key') BETWEEN 1 AND 200
   AND jsonb_typeof(p->'summary')='string' AND length(p->>'summary') BETWEEN 1 AND 400
   AND jsonb_typeof(p->'detail') IN('string','null') AND (jsonb_typeof(p->'detail')='null' OR length(p->>'detail')<=8000)
   AND p->>'status' IN('open','resolved','cancelled')
   AND p->>'source' IN('tool','diff-pass','scheduler')
   AND jsonb_typeof(p->'createdAt')='number' AND jsonb_typeof(p->'updatedAt')='number'
   AND jsonb_typeof(p->'resolvedAt') IN('number','null');
 ELSIF k='episodic_memory' THEN
  IF NOT (p ?& ARRAY['topicLabel','summary','messageSpan','entityRefs'])
   OR p-ARRAY['topicLabel','summary','messageSpan','entityRefs']<>'{}'::jsonb
   OR jsonb_typeof(p->'topicLabel') IS DISTINCT FROM 'string' OR length(p->>'topicLabel')=0
   OR jsonb_typeof(p->'summary') IS DISTINCT FROM 'string' OR length(p->>'summary')=0
   OR jsonb_typeof(p->'messageSpan') IS DISTINCT FROM 'object' OR jsonb_typeof(p->'entityRefs') NOT IN('array','null')
  THEN RETURN false; END IF;
  IF NOT ((p->'messageSpan') ?& ARRAY['fromSequence','toSequence','turnCount'])
   OR (p->'messageSpan')-ARRAY['fromSequence','toSequence','turnCount','fromMsgId','toMsgId']<>'{}'::jsonb THEN RETURN false; END IF;
  FOREACH item IN ARRAY ARRAY['fromSequence','toSequence','turnCount'] LOOP
   IF jsonb_typeof(p->'messageSpan'->item) IS DISTINCT FROM 'number'
    OR (p->'messageSpan'->>item)::numeric<0
    OR trunc((p->'messageSpan'->>item)::numeric)<>(p->'messageSpan'->>item)::numeric THEN RETURN false; END IF;
  END LOOP;
  RETURN (p->'messageSpan'->>'toSequence')::numeric >= (p->'messageSpan'->>'fromSequence')::numeric
   AND (NOT (p->'messageSpan' ? 'fromMsgId') OR jsonb_typeof(p->'messageSpan'->'fromMsgId')='string')
   AND (NOT (p->'messageSpan' ? 'toMsgId') OR jsonb_typeof(p->'messageSpan'->'toMsgId')='string');
 END IF;
 RETURN false;
EXCEPTION WHEN invalid_parameter_value OR invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION session_context_revision_snapshot(w uuid,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE revision session_context_scope_revisions;
BEGIN
 SELECT * INTO revision FROM session_context_scope_revisions r
  WHERE r.workspace_id=w AND r.id=i FOR SHARE;
 IF NOT FOUND THEN RETURN '{"held":true}'::jsonb; END IF;
 IF revision.scope_held OR scope_review_state_held('session_context_revision',i)
  OR NOT EXISTS(SELECT 1 FROM session_context_revision_contents c WHERE c.workspace_id=w AND c.revision_id=i)
  OR NOT EXISTS(SELECT 1 FROM sessions s WHERE s.workspace_id=w AND s.id=revision.session_id)
  OR revision.parent_kind='message_annotation' AND NOT EXISTS(SELECT 1 FROM session_messages m
    WHERE m.id=revision.parent_id AND m.session_id=revision.session_id AND m.workspace_id=w)
  OR revision.parent_kind IN('compact_summary','session_title') AND revision.parent_id<>revision.session_id
  OR revision.parent_kind='session_state' AND NOT EXISTS(SELECT 1 FROM session_state s
    WHERE s.id=revision.parent_id AND s.session_id=revision.session_id)
  OR revision.parent_kind='episodic_memory' AND NOT EXISTS(SELECT 1 FROM episodic_memories e
    WHERE e.id=revision.parent_id AND e.session_id=revision.session_id)
 THEN RETURN '{"held":true}'::jsonb; END IF;
 RETURN jsonb_build_object('workspaceId',w,'resourceKind','session_context_revision','resourceId',i,
  'userId',revision.user_id,'assistantId',revision.assistant_id,'sensitivity',revision.sensitivity,
  'compartments',revision.compartments,'projectIds',revision.project_ids,'version',revision.scope_version::text,
  'held',false,'validTo',NULL,'retractedAt',NULL);
END $$;

CREATE OR REPLACE FUNCTION validate_session_context_revision_pair() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE revision_id uuid;r session_context_scope_revisions;parent_row jsonb;payload jsonb;s sessions;
BEGIN
 IF TG_TABLE_NAME='session_context_scope_revisions' AND to_jsonb(NEW)->>'parent_kind'='session_title' THEN RETURN NULL;END IF;
 IF TG_TABLE_NAME='session_context_scope_revisions' THEN revision_id:=(to_jsonb(NEW)->>'id')::uuid;
 ELSIF TG_TABLE_NAME='session_message_annotation_heads' THEN
  SELECT to_jsonb(h) INTO parent_row FROM session_message_annotation_heads h WHERE h.message_id=NEW.message_id;
  IF parent_row IS NULL THEN RETURN NULL;END IF;
  revision_id:=(parent_row->>'scope_revision_id')::uuid;
 ELSIF TG_TABLE_NAME='sessions' THEN
  IF TG_OP='UPDATE' AND NEW.compact_summary IS NOT DISTINCT FROM OLD.compact_summary
   AND NEW.compact_boundary_sequence IS NOT DISTINCT FROM OLD.compact_boundary_sequence
   AND NEW.compact_scope_revision_id IS NOT DISTINCT FROM OLD.compact_scope_revision_id THEN RETURN NULL;END IF;
  SELECT to_jsonb(p) INTO parent_row FROM sessions p WHERE p.id=(to_jsonb(NEW)->>'id')::uuid;
  IF parent_row IS NULL THEN RETURN NULL;END IF;
  revision_id:=(parent_row->>'compact_scope_revision_id')::uuid;
  IF revision_id IS NULL AND parent_row->>'compact_summary' IS NULL THEN RETURN NULL;END IF;
 ELSE
  IF TG_TABLE_NAME='session_state' THEN
   SELECT to_jsonb(p) INTO parent_row FROM session_state p WHERE p.id=(to_jsonb(NEW)->>'id')::uuid;
   IF TG_OP='UPDATE' AND NEW.scope_revision_id IS NOT DISTINCT FROM OLD.scope_revision_id AND
    (to_jsonb(NEW)-ARRAY['updated_at'])=(to_jsonb(OLD)-ARRAY['updated_at']) THEN RETURN NULL;END IF;
  ELSE
   SELECT to_jsonb(p) INTO parent_row FROM episodic_memories p WHERE p.id=(to_jsonb(NEW)->>'id')::uuid;
   IF TG_OP='UPDATE' AND NEW.scope_revision_id IS NOT DISTINCT FROM OLD.scope_revision_id AND
    (to_jsonb(NEW)-ARRAY['last_accessed_at','access_count','survival_count'])=(to_jsonb(OLD)-ARRAY['last_accessed_at','access_count','survival_count']) THEN RETURN NULL;END IF;
  END IF;
  IF parent_row IS NULL THEN RETURN NULL;END IF;
  revision_id:=(parent_row->>'scope_revision_id')::uuid;
 END IF;
 IF revision_id IS NULL THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 SELECT * INTO r FROM session_context_scope_revisions WHERE id=revision_id;
 IF TG_TABLE_NAME='session_message_annotation_heads' AND
   (r.parent_kind IS DISTINCT FROM 'message_annotation' OR r.parent_id::text IS DISTINCT FROM parent_row->>'message_id'
    OR r.session_id::text IS DISTINCT FROM parent_row->>'session_id' OR r.workspace_id::text IS DISTINCT FROM parent_row->>'workspace_id')
  OR TG_TABLE_NAME='sessions' AND (r.parent_kind IS DISTINCT FROM 'compact_summary' OR r.parent_id IS DISTINCT FROM (to_jsonb(NEW)->>'id')::uuid OR r.session_id IS DISTINCT FROM (to_jsonb(NEW)->>'id')::uuid)
  OR TG_TABLE_NAME='session_state' AND (r.parent_kind IS DISTINCT FROM 'session_state' OR r.parent_id IS DISTINCT FROM (to_jsonb(NEW)->>'id')::uuid OR r.session_id::text IS DISTINCT FROM parent_row->>'session_id')
  OR TG_TABLE_NAME='episodic_memories' AND (r.parent_kind IS DISTINCT FROM 'episodic_memory' OR r.parent_id IS DISTINCT FROM (to_jsonb(NEW)->>'id')::uuid OR r.session_id::text IS DISTINCT FROM parent_row->>'session_id') THEN
  RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='22023';END IF;
 SELECT * INTO s FROM sessions WHERE id=r.session_id AND workspace_id=r.workspace_id;
 SELECT c.content INTO payload FROM session_context_revision_contents c WHERE c.workspace_id=r.workspace_id AND c.revision_id=r.id;
 IF r.id IS NULL OR s.id IS NULL OR r.scope_held OR payload IS NULL
  OR NOT EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=r.workspace_id AND d.resource_kind='session_context_revision'
    AND d.resource_id=r.id AND d.resource_version='1' AND d.user_id IS NOT DISTINCT FROM r.user_id AND d.assistant_id IS NOT DISTINCT FROM r.assistant_id
    AND d.sensitivity=r.sensitivity AND d.compartments=r.compartments AND d.project_ids=r.project_ids
    AND EXISTS(SELECT 1 FROM scope_derivation_sources edge WHERE edge.workspace_id=d.workspace_id AND edge.derivation_id=d.id))
  OR r.parent_kind<>'message_annotation' AND
   (r.user_id IS DISTINCT FROM (CASE WHEN s.visibility='personal' THEN s.user_id ELSE NULL END) OR r.assistant_id IS NOT NULL)
  OR r.parent_kind='message_annotation' AND s.visibility='personal' AND r.user_id IS DISTINCT FROM s.user_id
 THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 IF r.parent_kind='message_annotation' THEN
  SELECT to_jsonb(h) INTO parent_row FROM session_message_annotation_heads h
   JOIN session_messages m ON m.id=h.message_id AND m.session_id=h.session_id AND m.workspace_id=h.workspace_id
   WHERE h.message_id=r.parent_id AND h.session_id=r.session_id AND h.workspace_id=r.workspace_id;
  IF parent_row IS NULL OR parent_row->>'scope_revision_id' IS DISTINCT FROM r.id::text THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='22023';END IF;
 ELSIF r.parent_kind='compact_summary' THEN
  IF r.parent_id<>r.session_id OR s.compact_scope_revision_id IS DISTINCT FROM r.id OR s.compact_summary IS NOT NULL
   OR s.compact_boundary_sequence IS DISTINCT FROM (payload->>'boundarySequence')::int THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='22023';END IF;
 ELSIF r.parent_kind='session_state' THEN
  SELECT to_jsonb(p) INTO parent_row FROM session_state p WHERE p.id=r.parent_id AND p.session_id=r.session_id;
  IF parent_row IS NULL OR parent_row->>'scope_revision_id' IS DISTINCT FROM r.id::text OR parent_row->>'key' IS DISTINCT FROM r.parent_id::text
   OR parent_row->>'summary' IS DISTINCT FROM '' OR parent_row->>'detail' IS NOT NULL OR parent_row->>'status' IS DISTINCT FROM 'open'
   OR parent_row->>'source' IS DISTINCT FROM 'tool' OR parent_row->>'resolved_at' IS NOT NULL THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='22023';END IF;
 ELSE
  SELECT to_jsonb(p) INTO parent_row FROM episodic_memories p WHERE p.id=r.parent_id AND p.session_id=r.session_id;
  IF parent_row IS NULL OR parent_row->>'scope_revision_id' IS DISTINCT FROM r.id::text OR parent_row->>'topic_label' IS DISTINCT FROM ''
   OR parent_row->>'summary' IS DISTINCT FROM '' OR parent_row->'message_span' IS DISTINCT FROM '{}'::jsonb OR parent_row->>'entity_refs' IS NOT NULL THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='22023';END IF;
 END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION validate_session_title_pair() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE revision_id uuid;r session_context_scope_revisions;s sessions;h session_title_heads;payload jsonb;
BEGIN
 IF TG_TABLE_NAME='session_context_scope_revisions' THEN revision_id:=NEW.id;
 ELSIF TG_TABLE_NAME='sessions' THEN
  IF TG_OP='UPDATE' AND NEW.title IS NOT DISTINCT FROM OLD.title AND NEW.title_manually_set IS NOT DISTINCT FROM OLD.title_manually_set THEN RETURN NULL;END IF;
  SELECT * INTO h FROM session_title_heads WHERE workspace_id=NEW.workspace_id AND session_id=NEW.id;
  -- Unproved legacy scalars never become canonical title payloads.
  IF NOT FOUND THEN RETURN NULL;END IF;
  revision_id:=h.scope_revision_id;
 ELSE
  SELECT * INTO h FROM session_title_heads WHERE workspace_id=NEW.workspace_id AND session_id=NEW.session_id;
  IF NOT FOUND THEN RETURN NULL;END IF;
  revision_id:=h.scope_revision_id;
 END IF;
 SELECT * INTO r FROM session_context_scope_revisions WHERE id=revision_id;
 SELECT * INTO s FROM sessions WHERE workspace_id=r.workspace_id AND id=r.session_id;
 SELECT * INTO h FROM session_title_heads WHERE workspace_id=r.workspace_id AND session_id=r.session_id;
 SELECT c.content INTO payload FROM session_context_revision_contents c WHERE c.workspace_id=r.workspace_id AND c.revision_id=r.id;
 IF r.id IS NULL OR s.id IS NULL OR h.scope_revision_id IS DISTINCT FROM r.id OR r.parent_kind IS DISTINCT FROM 'session_title'
  OR r.parent_id IS DISTINCT FROM r.session_id OR r.scope_held OR s.title IS NOT NULL
  OR session_context_payload_shape('session_title',payload) IS NOT TRUE
  OR s.title_manually_set IS DISTINCT FROM (payload->>'manual')::boolean
  OR r.user_id IS DISTINCT FROM (CASE WHEN s.visibility='personal' THEN s.user_id ELSE NULL END) OR r.assistant_id IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=r.workspace_id AND d.resource_kind='session_context_revision'
   AND d.resource_id=r.id AND d.resource_version='1' AND d.user_id IS NOT DISTINCT FROM r.user_id AND d.assistant_id IS NOT DISTINCT FROM r.assistant_id
   AND d.sensitivity=r.sensitivity AND d.compartments=r.compartments AND d.project_ids=r.project_ids
   AND EXISTS(SELECT 1 FROM scope_derivation_sources edge WHERE edge.workspace_id=d.workspace_id AND edge.derivation_id=d.id)) THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION validate_session_title_pair() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER session_title_revision_pair AFTER INSERT ON session_context_scope_revisions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.parent_kind='session_title') EXECUTE FUNCTION validate_session_title_pair();
CREATE CONSTRAINT TRIGGER session_title_head_pair AFTER INSERT OR UPDATE ON session_title_heads
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_session_title_pair();
CREATE CONSTRAINT TRIGGER session_title_parent_pair AFTER INSERT OR UPDATE ON sessions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_session_title_pair();
CREATE FUNCTION guard_session_title_head() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'scope_revision_id')=(to_jsonb(OLD)-'scope_revision_id') THEN RETURN NEW;END IF;
 IF TG_OP='DELETE' AND (NOT EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id)
  OR NOT EXISTS(SELECT 1 FROM sessions WHERE id=OLD.session_id)) THEN RETURN OLD;END IF;
 RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';
END $$;
REVOKE ALL ON FUNCTION guard_session_title_head() FROM PUBLIC;
CREATE TRIGGER session_title_head_identity BEFORE UPDATE OR DELETE ON session_title_heads
 FOR EACH ROW EXECUTE FUNCTION guard_session_title_head();

CREATE OR REPLACE FUNCTION publish_native_session_context_revision(w uuid,s uuid,k text,p uuid,i uuid,payload jsonb,producer text,sources jsonb,
 expected_revision uuid,expected_generation bigint,expected_cursor integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;parent jsonb;target sessions;
 source jsonb;current_source jsonb;floor_tier text;teams text[];projects uuid[];previous uuid;derivation uuid;created timestamptz;memo jsonb:='{}';evaluated jsonb;
BEGIN
 parent:=lock_native_session_context_publication(w,s);
 IF k NOT IN('session_state','episodic_memory','compact_summary','message_annotation','session_title') OR p IS NULL OR i IS NULL
  OR session_context_payload_shape(k,payload) IS NOT TRUE OR length(btrim(producer)) NOT BETWEEN 1 AND 256
  OR jsonb_typeof(sources) IS DISTINCT FROM 'array' OR jsonb_array_length(sources) NOT BETWEEN 1 AND 4096
  OR (SELECT count(DISTINCT (node->>'resourceKind',node->>'resourceId')) FROM jsonb_array_elements(sources) node)<>jsonb_array_length(sources) THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 SELECT * INTO STRICT target FROM sessions WHERE workspace_id=w AND id=s;
 IF expected_generation IS NOT NULL AND target.session_context_generation<>expected_generation THEN RETURN NULL;END IF;
 IF k='session_title' THEN
  IF p<>s OR (payload->>'manual')::boolean IS FALSE AND target.title_manually_set THEN RETURN NULL;END IF;
  SELECT scope_revision_id INTO previous FROM session_title_heads WHERE workspace_id=w AND session_id=s;
  IF previous IS DISTINCT FROM expected_revision THEN RETURN NULL;END IF;
 ELSIF k='compact_summary' THEN
  IF p<>s OR target.compact_boundary_sequence IS DISTINCT FROM expected_cursor THEN RETURN NULL;END IF;
 ELSIF k='message_annotation' THEN
  IF NOT EXISTS(SELECT 1 FROM session_messages WHERE workspace_id=w AND session_id=s AND id=p)
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(sources) node WHERE node->>'resourceKind'='session_message' AND node->>'resourceId'=p::text) THEN
   RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
  SELECT scope_revision_id INTO previous FROM session_message_annotation_heads WHERE workspace_id=w AND session_id=s AND message_id=p;
  IF previous IS DISTINCT FROM expected_revision THEN RETURN NULL;END IF;
 ELSIF k='session_state' THEN
  SELECT scope_revision_id INTO previous FROM session_state WHERE id=p AND session_id=s;
  IF FOUND THEN IF previous IS DISTINCT FROM expected_revision THEN RETURN NULL;END IF;
  ELSIF expected_revision IS NOT NULL OR expected_generation IS NULL THEN RETURN NULL;END IF;
 ELSE
  IF expected_revision IS NOT NULL OR EXISTS(SELECT 1 FROM episodic_memories WHERE id=p) THEN RETURN NULL;END IF;
 END IF;
 floor_tier:=parent->>'sensitivity';teams:=ARRAY(SELECT jsonb_array_elements_text(parent->'compartments'));
 projects:=ARRAY(SELECT jsonb_array_elements_text(parent->'projectIds')::uuid);
 FOR source IN SELECT value FROM jsonb_array_elements(sources) ORDER BY value->>'resourceKind',value->>'resourceId' LOOP
  IF entity_derivation_envelope_valid(source) IS NOT TRUE OR source->>'workspaceId' IS DISTINCT FROM w::text
   OR source->>'userId' IS NOT NULL AND source->>'userId' IS DISTINCT FROM actor::text THEN
   RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
  IF source->>'resourceKind'='application_field' THEN
   evaluated:=application_session_eval_field(w,(source->>'resourceId')::uuid,source->>'version',memo);memo:=coalesce(evaluated->'memo',memo);current_source:=evaluated->'value';
  ELSIF source->>'resourceKind'='external_source' THEN
   current_source:=external_source_snapshot(w,(source->>'resourceId')::uuid);
   IF external_source_retention_allowed(w,(source->>'resourceId')::uuid,source->>'version') IS NOT TRUE THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  ELSE current_source:=read_admitted_native_scope_snapshot(w,source->>'resourceKind',(source->>'resourceId')::uuid);END IF;
  IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false'
   OR current_source->>'version' IS DISTINCT FROM source->>'version'
   OR current_source->>'validTo' IS NOT NULL OR current_source->>'retractedAt' IS NOT NULL
   OR (current_source->'workspaceId',current_source->'userId',current_source->'assistantId',current_source->'sensitivity')
    IS DISTINCT FROM (source->'workspaceId',source->'userId',source->'assistantId',source->'sensitivity')
   OR NOT (current_source->'compartments')@>(source->'compartments') OR NOT (source->'compartments')@>(current_source->'compartments')
   OR NOT (current_source->'projectIds')@>(source->'projectIds') OR NOT (source->'projectIds')@>(current_source->'projectIds') THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF sensitivity_rank(source->>'sensitivity')>sensitivity_rank(floor_tier) THEN floor_tier:=source->>'sensitivity';END IF;
  teams:=ARRAY(SELECT DISTINCT item FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(source->'compartments'))) item ORDER BY item);
  projects:=ARRAY(SELECT DISTINCT item FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(source->'projectIds')::uuid)) item ORDER BY item);
 END LOOP;
 IF member_operation_scope_allows(w,floor_tier,teams,true) IS NOT TRUE OR agent_mutation_scope_allows(teams) IS NOT TRUE
  OR agent_read_scope_allows(floor_tier,teams,projects) IS NOT TRUE THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 INSERT INTO session_context_scope_revisions(id,workspace_id,session_id,parent_kind,parent_id,user_id,assistant_id,sensitivity,compartments,project_ids,payload_sha256)
  VALUES(i,w,s,k,p,(parent->>'userId')::uuid,NULL,floor_tier,teams,projects,encode(sha256(convert_to(payload::text,'UTF8')),'hex')) RETURNING created_at INTO created;
 INSERT INTO session_context_revision_contents(workspace_id,revision_id,content) VALUES(w,i,payload);
 IF k='session_state' THEN
  INSERT INTO session_state(id,session_id,user_id,assistant_id,key,status,summary,detail,source,scope_revision_id)
   VALUES(p,s,target.user_id,target.assistant_id,p::text,'open','',NULL,'tool',i)
   ON CONFLICT(id) DO UPDATE SET scope_revision_id=EXCLUDED.scope_revision_id,updated_at=now();
 ELSIF k='episodic_memory' THEN
  INSERT INTO episodic_memories(id,user_id,assistant_id,session_id,topic_label,summary,message_span,scope_revision_id)
   VALUES(p,target.user_id,target.assistant_id,s,'','','{}',i);
 ELSIF k='session_title' THEN
  INSERT INTO session_title_heads(workspace_id,session_id,scope_revision_id) VALUES(w,s,i)
   ON CONFLICT(session_id) DO UPDATE SET scope_revision_id=EXCLUDED.scope_revision_id;
  UPDATE sessions SET title=NULL,title_manually_set=(payload->>'manual')::boolean WHERE workspace_id=w AND id=s;
 ELSIF k='message_annotation' THEN
  INSERT INTO session_message_annotation_heads(message_id,workspace_id,session_id,scope_revision_id) VALUES(p,w,s,i)
   ON CONFLICT(message_id) DO UPDATE SET scope_revision_id=EXCLUDED.scope_revision_id;
 ELSE
  UPDATE sessions SET compact_summary=NULL,compact_scope_revision_id=i,compact_boundary_sequence=(payload->>'boundarySequence')::integer,
   compaction_count=compaction_count+1,last_compacted_at=now() WHERE workspace_id=w AND id=s;
 END IF;
 UPDATE sessions SET session_context_generation=session_context_generation+1 WHERE workspace_id=w AND id=s;
 INSERT INTO workspace_access_policies(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;
 INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
  SELECT w,'session_context_revision',i,'1',producer,(parent->>'userId')::uuid,NULL,floor_tier,teams,projects,revision FROM workspace_access_policies WHERE workspace_id=w RETURNING id INTO derivation;
 INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
  SELECT w,derivation,node->>'resourceKind',(node->>'resourceId')::uuid,node->>'version' FROM jsonb_array_elements(sources) node ORDER BY node->>'resourceKind',node->>'resourceId';
 IF k='session_title' THEN
  memo:='{}';parent:=lock_native_session_context_publication(w,s);
 floor_tier:=parent->>'sensitivity';teams:=ARRAY(SELECT jsonb_array_elements_text(parent->'compartments'));
 projects:=ARRAY(SELECT jsonb_array_elements_text(parent->'projectIds')::uuid);
 FOR source IN SELECT value FROM jsonb_array_elements(sources) ORDER BY value->>'resourceKind',value->>'resourceId' LOOP
  IF entity_derivation_envelope_valid(source) IS NOT TRUE OR source->>'workspaceId' IS DISTINCT FROM w::text
   OR source->>'userId' IS NOT NULL AND source->>'userId' IS DISTINCT FROM actor::text THEN
   RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
  IF source->>'resourceKind'='application_field' THEN
   evaluated:=application_session_eval_field(w,(source->>'resourceId')::uuid,source->>'version',memo);memo:=coalesce(evaluated->'memo',memo);current_source:=evaluated->'value';
  ELSIF source->>'resourceKind'='external_source' THEN
   current_source:=external_source_snapshot(w,(source->>'resourceId')::uuid);
   IF external_source_retention_allowed(w,(source->>'resourceId')::uuid,source->>'version') IS NOT TRUE THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  ELSE current_source:=read_admitted_native_scope_snapshot(w,source->>'resourceKind',(source->>'resourceId')::uuid);END IF;
  IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false'
   OR current_source->>'version' IS DISTINCT FROM source->>'version'
   OR current_source->>'validTo' IS NOT NULL OR current_source->>'retractedAt' IS NOT NULL
   OR (current_source->'workspaceId',current_source->'userId',current_source->'assistantId',current_source->'sensitivity')
    IS DISTINCT FROM (source->'workspaceId',source->'userId',source->'assistantId',source->'sensitivity')
   OR NOT (current_source->'compartments')@>(source->'compartments') OR NOT (source->'compartments')@>(current_source->'compartments')
   OR NOT (current_source->'projectIds')@>(source->'projectIds') OR NOT (source->'projectIds')@>(current_source->'projectIds') THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF sensitivity_rank(source->>'sensitivity')>sensitivity_rank(floor_tier) THEN floor_tier:=source->>'sensitivity';END IF;
  teams:=ARRAY(SELECT DISTINCT item FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(source->'compartments'))) item ORDER BY item);
  projects:=ARRAY(SELECT DISTINCT item FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(source->'projectIds')::uuid)) item ORDER BY item);
 END LOOP;
 IF member_operation_scope_allows(w,floor_tier,teams,true) IS NOT TRUE OR agent_mutation_scope_allows(teams) IS NOT TRUE
  OR agent_read_scope_allows(floor_tier,teams,projects) IS NOT TRUE THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
  IF NOT EXISTS(SELECT 1 FROM session_context_scope_revisions r WHERE r.workspace_id=w AND r.id=i
   AND r.sensitivity=floor_tier AND r.compartments=teams AND r.project_ids=projects) THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 END IF;
 RETURN jsonb_build_object('source',jsonb_build_object('workspaceId',w,'resourceKind','session_context_revision','resourceId',i,'version','1',
  'userId',parent->'userId','assistantId',NULL,'sensitivity',floor_tier,'compartments',teams,'projectIds',projects),
  'createdAt',created,'userId',target.user_id,'assistantId',target.assistant_id);
END $$;
-- Compare the discovered current head in the same non-owner payload frame.
CREATE FUNCTION read_session_title_revision(w uuid,s uuid,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE current_revision uuid;
BEGIN
 SELECT h.scope_revision_id INTO current_revision FROM session_title_heads h
  WHERE h.workspace_id=w AND h.session_id=s FOR SHARE;
 IF current_revision IS DISTINCT FROM i OR NOT EXISTS(SELECT 1 FROM session_context_scope_revisions r
  WHERE r.workspace_id=w AND r.id=i AND r.session_id=s AND r.parent_kind='session_title' AND r.parent_id=s) THEN RETURN NULL;END IF;
 RETURN read_session_context_revision(w,i);
END $$;
REVOKE ALL ON FUNCTION read_session_title_revision(uuid,uuid,uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN GRANT EXECUTE ON FUNCTION read_session_title_revision(uuid,uuid,uuid) TO app_user;END IF;END $$;
COMMIT;
