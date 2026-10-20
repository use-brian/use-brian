-- [COMP:api/session-message-annotations] Distinct immutable generated annotations.
BEGIN;
-- Only the reviewed8054 functions are extended. Unknown preexisting changes
-- refuse installation instead of overwriting another authority contract.
DO $review$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.session_context_payload_shape(text,jsonb)') AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='a75a9522692872b0ac0ebfb932d4ebca29a60cdb29a84b141aa049adde165772') THEN RAISE EXCEPTION 'Persistent annotation prerequisite changed: session_context_payload_shape';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.session_context_revision_snapshot(uuid,uuid)') AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='70e61b2326cf1248192d5a101cd6359871d907ef65c91f83d66b1180305f1cf7') THEN RAISE EXCEPTION 'Persistent annotation prerequisite changed: session_context_revision_snapshot';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.session_context_revision_native(uuid,uuid)') AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='00f17a61c81199852ae8a01a0a83519a7486e290fa6364da4ebb8cc1e5a1dc0b') THEN RAISE EXCEPTION 'Persistent annotation prerequisite changed: session_context_revision_native';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.validate_session_context_revision_pair()') AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='703743a2284a27891baabe6d1edc2247cbaf0584d5cbecb498c0bdfba5b1797c') THEN RAISE EXCEPTION 'Persistent annotation prerequisite changed: validate_session_context_revision_pair';END IF;
END $review$;
DO $parent_kind$ DECLARE expression text;BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT expression FROM pg_constraint
  WHERE conrelid='session_context_scope_revisions'::regclass AND conname='session_context_scope_revisions_parent_kind_check';
 ALTER TABLE session_context_scope_revisions DROP CONSTRAINT session_context_scope_revisions_parent_kind_check;
 EXECUTE format('ALTER TABLE session_context_scope_revisions ADD CONSTRAINT session_context_scope_revisions_parent_kind_check CHECK((%s) OR parent_kind=%L)',expression,'message_annotation');
END $parent_kind$;
CREATE TABLE session_message_annotation_heads (
 message_id uuid PRIMARY KEY REFERENCES session_messages(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 scope_revision_id uuid NOT NULL,
 FOREIGN KEY(workspace_id,scope_revision_id) REFERENCES session_context_scope_revisions(workspace_id,id)
);
CREATE INDEX session_message_annotation_session ON session_message_annotation_heads(workspace_id,session_id);
ALTER TABLE session_message_annotation_heads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON session_message_annotation_heads FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN REVOKE ALL ON session_message_annotation_heads FROM app_user;END IF;END $$;
CREATE OR REPLACE FUNCTION session_context_payload_shape(k text,p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE item text;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF k='message_annotation' THEN
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
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
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
  OR revision.parent_kind='compact_summary' AND revision.parent_id<>revision.session_id
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

CREATE OR REPLACE FUNCTION session_context_revision_native(w uuid,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE root jsonb;parent jsonb;r session_context_scope_revisions;
BEGIN
 root:=session_context_revision_snapshot(w,i);
 SELECT * INTO r FROM session_context_scope_revisions WHERE workspace_id=w AND id=i;
 parent:=session_context_parent_snapshot(w,r.session_id);
 IF r.parent_kind='message_annotation' AND
  read_admitted_native_scope_snapshot(w,'session_message',r.parent_id)->>'held' IS DISTINCT FROM 'false'
 THEN RETURN '{"held":true}';END IF;
 IF root->>'held' IS DISTINCT FROM 'false' OR parent IS NULL OR workflow_evidence_envelope_visible(w,parent) IS NOT TRUE
  OR agent_visibility_allows(w,r.user_id,r.assistant_id) IS NOT TRUE
  OR workflow_evidence_envelope_visible(w,root) IS NOT TRUE THEN RETURN '{"held":true}';END IF;
 RETURN root;
END $$;

CREATE OR REPLACE FUNCTION validate_session_context_revision_pair() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE revision_id uuid;r session_context_scope_revisions;parent_row jsonb;payload jsonb;s sessions;
BEGIN
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

CREATE FUNCTION guard_session_message_annotation_head() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'scope_revision_id')=(to_jsonb(OLD)-'scope_revision_id') THEN RETURN NEW;END IF;
 IF TG_OP='DELETE' AND (NOT EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id)
  OR NOT EXISTS(SELECT 1 FROM sessions WHERE id=OLD.session_id)
  OR NOT EXISTS(SELECT 1 FROM session_messages WHERE id=OLD.message_id)) THEN RETURN OLD;END IF;
 RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';
END $$;
REVOKE ALL ON FUNCTION guard_session_message_annotation_head() FROM PUBLIC;
CREATE TRIGGER session_message_annotation_head_identity BEFORE UPDATE OR DELETE ON session_message_annotation_heads
 FOR EACH ROW EXECUTE FUNCTION guard_session_message_annotation_head();
CREATE CONSTRAINT TRIGGER session_message_annotation_pair AFTER INSERT OR UPDATE ON session_message_annotation_heads
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_session_context_revision_pair();
CREATE FUNCTION purge_session_message_annotations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 DELETE FROM session_context_revision_contents c USING session_context_scope_revisions r
  WHERE c.workspace_id=r.workspace_id AND c.revision_id=r.id AND r.parent_kind='message_annotation'
   AND r.parent_id=OLD.id AND r.session_id=OLD.session_id AND r.workspace_id=OLD.workspace_id;
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION purge_session_message_annotations() FROM PUBLIC;
CREATE TRIGGER session_message_annotation_purge AFTER DELETE ON session_messages
 FOR EACH ROW EXECUTE FUNCTION purge_session_message_annotations();
-- No source kind/ancestry table is added; the existing reviewed eight-function
-- R2 metadata kernel remains unchanged and still falls back on unknown kernels.
COMMIT;
