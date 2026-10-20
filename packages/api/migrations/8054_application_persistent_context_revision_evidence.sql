-- [COMP:api/application-persistence] Immutable, purgable session context revisions.
BEGIN;

-- Immutable evidence survives parent edits/deletion. Protected payload bytes have
-- a separate lifecycle so R4 can purge them without rewriting the observations.
CREATE TABLE session_context_scope_revisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 session_id uuid NOT NULL,
 parent_kind text NOT NULL CHECK(parent_kind IN('compact_summary','session_state','episodic_memory')),
 parent_id uuid NOT NULL,
 user_id uuid,
 assistant_id uuid,
 sensitivity text NOT NULL CHECK(sensitivity IN('public','internal','confidential')),
 compartments text[] NOT NULL CHECK(array_position(compartments,NULL) IS NULL),
 project_ids uuid[] NOT NULL CHECK(array_position(project_ids,NULL) IS NULL),
 scope_version bigint NOT NULL DEFAULT 1 CHECK(scope_version=1),
 scope_held boolean NOT NULL DEFAULT false,
 payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,id)
);
CREATE INDEX session_context_revision_parent ON session_context_scope_revisions(workspace_id,session_id,parent_kind,parent_id);
CREATE TABLE session_context_revision_contents (
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 revision_id uuid PRIMARY KEY,
 content jsonb NOT NULL CHECK(jsonb_typeof(content)='object'),
 FOREIGN KEY(workspace_id,revision_id) REFERENCES session_context_scope_revisions(workspace_id,id) ON DELETE CASCADE
);
ALTER TABLE sessions ADD COLUMN session_context_generation bigint NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN compact_scope_revision_id uuid REFERENCES session_context_scope_revisions(id);
ALTER TABLE session_state ADD COLUMN scope_revision_id uuid REFERENCES session_context_scope_revisions(id);
ALTER TABLE episodic_memories ADD COLUMN scope_revision_id uuid REFERENCES session_context_scope_revisions(id);
-- Existing rows deliberately keep NULL pointers. No classification or lineage is guessed.

ALTER TABLE session_context_scope_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_context_revision_contents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON session_context_scope_revisions,session_context_revision_contents FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  REVOKE ALL ON session_context_scope_revisions,session_context_revision_contents FROM app_user;
 END IF;
END $$;

-- Append one closed kind without replacing any prior owner's registry expression.
DO $$ DECLARE target record; expression text; BEGIN
 FOR target IN SELECT * FROM (VALUES
  ('scope_derivations','scope_derivations_resource_kind_check','resource_kind'),
  ('scope_derivation_sources','scope_derivation_sources_source_kind_check','source_kind'),
  ('scope_resource_states','scope_resource_states_resource_kind_check','resource_kind')
 ) AS t(tab,name,col) LOOP
  SELECT pg_get_expr(c.conbin,c.conrelid) INTO STRICT expression FROM pg_constraint c
   WHERE c.conrelid=target.tab::regclass AND c.conname=target.name;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',target.tab,target.name);
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK((%s) OR %I=%L)',
   target.tab,target.name,expression,target.col,'session_context_revision');
 END LOOP;
END $$;
ALTER FUNCTION scope_source_table(text) RENAME TO scope_source_table_before_persistent_context;
REVOKE ALL ON FUNCTION scope_source_table_before_persistent_context(text) FROM PUBLIC;
CREATE FUNCTION scope_source_table(k text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN k='session_context_revision' THEN 'session_context_scope_revisions' ELSE scope_source_table_before_persistent_context(k) END
$$;
REVOKE ALL ON FUNCTION scope_source_table(text) FROM PUBLIC;

CREATE FUNCTION guard_session_context_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN RETURN OLD; END IF;
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'scope_held')=(to_jsonb(OLD)-'scope_held')
  AND (NEW.scope_held=OLD.scope_held OR NOT OLD.scope_held AND NEW.scope_held) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';
END $$;
REVOKE ALL ON FUNCTION guard_session_context_revision() FROM PUBLIC;
CREATE TRIGGER session_context_revision_immutable BEFORE UPDATE OR DELETE ON session_context_scope_revisions
 FOR EACH ROW EXECUTE FUNCTION guard_session_context_revision();

-- Closed payload shape and immutable content hash. Legacy plaintext is never adopted.
CREATE FUNCTION session_context_payload_shape(k text,p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE item text;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF k='compact_summary' THEN
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
REVOKE ALL ON FUNCTION session_context_payload_shape(text,jsonb) FROM PUBLIC;

CREATE FUNCTION guard_session_context_content() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE expected text; kind text;
BEGIN
 IF TG_OP='INSERT' THEN
  SELECT payload_sha256,parent_kind INTO expected,kind FROM session_context_scope_revisions
   WHERE workspace_id=NEW.workspace_id AND id=NEW.revision_id FOR SHARE;
  IF expected IS NULL OR session_context_payload_shape(kind,NEW.content) IS NOT TRUE
   OR expected<>encode(sha256(convert_to(NEW.content::text,'UTF8')),'hex') THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='22023'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN
  -- Purging bytes holds the immutable source before any later model/output use.
  IF EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN
   UPDATE session_context_scope_revisions SET scope_held=true WHERE workspace_id=OLD.workspace_id AND id=OLD.revision_id;
   PERFORM hold_scope_descendants(OLD.workspace_id,'session_context_revision',OLD.revision_id);
  END IF;
  RETURN OLD;
 END IF;
 RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';
END $$;
REVOKE ALL ON FUNCTION guard_session_context_content() FROM PUBLIC;
CREATE TRIGGER session_context_content_guard BEFORE INSERT OR UPDATE OR DELETE ON session_context_revision_contents
 FOR EACH ROW EXECUTE FUNCTION guard_session_context_content();

-- Extend existing transitive holding; preserve every previous kind's behavior.
ALTER FUNCTION hold_scope_descendants(uuid,text,uuid) RENAME TO hold_scope_descendants_before_persistent_context;
REVOKE ALL ON FUNCTION hold_scope_descendants_before_persistent_context(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION hold_scope_descendants(w uuid,k text,i uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM hold_scope_descendants_before_persistent_context(w,k,i);
 WITH RECURSIVE descendants(kind,id) AS (
  SELECT d.resource_kind,d.resource_id FROM scope_derivations d
   JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
   WHERE s.workspace_id=w AND s.source_kind=k AND s.source_id=i
  UNION
  SELECT d.resource_kind,d.resource_id FROM descendants p
   JOIN scope_derivation_sources s ON s.workspace_id=w AND s.source_kind=p.kind AND s.source_id=p.id
   JOIN scope_derivations d ON d.workspace_id=w AND d.id=s.derivation_id
 ) UPDATE session_context_scope_revisions r SET scope_held=true
  WHERE r.workspace_id=w AND NOT r.scope_held AND r.id IN(SELECT id FROM descendants WHERE kind='session_context_revision');
END $$;
REVOKE ALL ON FUNCTION hold_scope_descendants(uuid,text,uuid) FROM PUBLIC;

-- New persistent observations do not inherit native historical D1 gone semantics.
-- Owner-only immutable metadata. The admitted facade below grants no owner-pool read.
CREATE FUNCTION session_context_revision_snapshot(w uuid,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE revision session_context_scope_revisions;
BEGIN
 SELECT * INTO revision FROM session_context_scope_revisions r
  WHERE r.workspace_id=w AND r.id=i FOR SHARE;
 IF NOT FOUND THEN RETURN '{"held":true}'::jsonb; END IF;
 IF revision.scope_held OR scope_review_state_held('session_context_revision',i)
  OR NOT EXISTS(SELECT 1 FROM session_context_revision_contents c WHERE c.workspace_id=w AND c.revision_id=i)
  OR NOT EXISTS(SELECT 1 FROM sessions s WHERE s.workspace_id=w AND s.id=revision.session_id)
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
REVOKE ALL ON FUNCTION session_context_revision_snapshot(uuid,uuid) FROM PUBLIC;
ALTER FUNCTION read_scope_source(uuid,text,uuid) RENAME TO read_scope_source_before_persistent_context;
REVOKE ALL ON FUNCTION read_scope_source_before_persistent_context(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_scope_source(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF k='session_context_revision' THEN RETURN session_context_revision_snapshot(w,i); END IF;
 RETURN read_scope_source_before_persistent_context(w,k,i);
END $$;
REVOKE ALL ON FUNCTION read_scope_source(uuid,text,uuid) FROM PUBLIC;

-- Parent removal purges protected payload but retains observation identity and
-- complete derivation metadata. The content DELETE guard holds descendants.
CREATE FUNCTION purge_session_context_parent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target_session uuid; kind text;
BEGIN
 IF TG_TABLE_NAME='sessions' THEN
  target_session:=OLD.id;
  DELETE FROM session_context_revision_contents c USING session_context_scope_revisions r
   WHERE c.revision_id=r.id AND c.workspace_id=r.workspace_id AND r.session_id=target_session;
 ELSE
  target_session:=OLD.session_id;
  kind:=CASE TG_TABLE_NAME WHEN 'session_state' THEN 'session_state' ELSE 'episodic_memory' END;
  DELETE FROM session_context_revision_contents c USING session_context_scope_revisions r
   WHERE c.revision_id=r.id AND c.workspace_id=r.workspace_id AND r.session_id=target_session
    AND r.parent_kind=kind AND r.parent_id=OLD.id;
 END IF;
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION purge_session_context_parent() FROM PUBLIC;
CREATE TRIGGER session_context_session_purge AFTER DELETE ON sessions
 FOR EACH ROW EXECUTE FUNCTION purge_session_context_parent();
CREATE TRIGGER session_context_state_purge AFTER DELETE ON session_state
 FOR EACH ROW EXECUTE FUNCTION purge_session_context_parent();
CREATE TRIGGER session_context_episode_purge AFTER DELETE ON episodic_memories
 FOR EACH ROW EXECUTE FUNCTION purge_session_context_parent();


-- Share the canonical audience predicates with sessions RLS. In particular,
-- workspace user_id is created-by and confers no ownership right.
CREATE FUNCTION session_personal_audience(s sessions) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT s.visibility='personal' AND s.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
$$;
CREATE FUNCTION session_workspace_audience(s sessions) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT s.visibility='workspace' AND s.workspace_id IS NOT NULL AND EXISTS(
  SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=s.workspace_id
   AND wm.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
   AND sensitivity_rank(s.effective_clearance)<=sensitivity_rank(wm.clearance)
   AND (effective_member_team_compartments(wm.user_id,wm.workspace_id) IS NULL
    OR s.context_compartments <@ effective_member_team_compartments(wm.user_id,wm.workspace_id)))
$$;
CREATE FUNCTION session_project_audience(s sessions,mutation boolean) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT project_labels_allowed((SELECT department_read_grants()),s.workspace_id,s.context_compartments,mutation)
$$;
REVOKE ALL ON FUNCTION session_personal_audience(sessions),session_workspace_audience(sessions),session_project_audience(sessions,boolean) FROM PUBLIC;
ALTER POLICY sessions_own ON sessions USING(session_personal_audience(sessions));
ALTER POLICY sessions_workspace_shared ON sessions USING(session_workspace_audience(sessions));
ALTER POLICY sessions_project_scope ON sessions USING(session_project_audience(sessions,false)) WITH CHECK(session_project_audience(sessions,true));

CREATE FUNCTION session_context_parent_snapshot(w uuid,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s sessions;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid;
BEGIN
 -- There is no application data grant for a raw native session. A canonical
 -- application-session port must be integrated before that lane is available.
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
  OR nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)::uuid<>w
  OR nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL AND current_setting('app.agent_actor_id',true)::uuid<>actor
  OR acting IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM assistants a WHERE a.workspace_id=w AND a.id=acting)
    OR assistant_placement_visible(actor,acting) IS NOT TRUE) THEN RETURN NULL;END IF;
 SELECT * INTO s FROM sessions WHERE workspace_id=w AND id=i FOR SHARE;
 IF NOT FOUND OR NOT coalesce(session_personal_audience(s) OR session_workspace_audience(s),false)
  OR session_project_audience(s,false) IS NOT TRUE THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('workspaceId',w,'userId',CASE WHEN s.visibility='personal' THEN s.user_id ELSE NULL END,
  'assistantId',NULL,'sensitivity',s.effective_clearance,'compartments',s.context_compartments,
  'projectIds',CASE WHEN s.context_project_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(s.context_project_id) END,
  'assistant',s.assistant_id,'createdBy',s.user_id);
END $$;
REVOKE ALL ON FUNCTION session_context_parent_snapshot(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION session_context_revision_native(w uuid,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE root jsonb;parent jsonb;r session_context_scope_revisions;
BEGIN
 root:=session_context_revision_snapshot(w,i);
 SELECT * INTO r FROM session_context_scope_revisions WHERE workspace_id=w AND id=i;
 parent:=session_context_parent_snapshot(w,r.session_id);
 IF root->>'held' IS DISTINCT FROM 'false' OR parent IS NULL OR workflow_evidence_envelope_visible(w,parent) IS NOT TRUE
  OR agent_visibility_allows(w,r.user_id,r.assistant_id) IS NOT TRUE
  OR workflow_evidence_envelope_visible(w,root) IS NOT TRUE THEN RETURN '{"held":true}';END IF;
 RETURN root;
END $$;
REVOKE ALL ON FUNCTION session_context_revision_native(uuid,uuid) FROM PUBLIC;
ALTER FUNCTION read_admitted_native_scope_snapshot(uuid,text,uuid) RENAME TO read_admitted_native_scope_snapshot_before_persistent_context;
REVOKE ALL ON FUNCTION read_admitted_native_scope_snapshot_before_persistent_context(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_admitted_native_scope_snapshot(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF k='session_context_revision' THEN RETURN session_context_revision_native(w,i);END IF;
 RETURN read_admitted_native_scope_snapshot_before_persistent_context(w,k,i);
END $$;
REVOKE ALL ON FUNCTION read_admitted_native_scope_snapshot(uuid,text,uuid) FROM PUBLIC;
ALTER FUNCTION read_entity_derivation_source(uuid,text,uuid) RENAME TO read_entity_derivation_source_before_persistent_context;
REVOKE ALL ON FUNCTION read_entity_derivation_source_before_persistent_context(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_entity_derivation_source(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE root jsonb;source jsonb;admitted jsonb;required jsonb:='[]';
BEGIN
 IF k<>'session_context_revision' THEN RETURN read_entity_derivation_source_before_persistent_context(w,k,i);END IF;
 root:=session_context_revision_native(w,i);
 IF root->>'held' IS DISTINCT FROM 'false' THEN RETURN NULL;END IF;
 FOR source IN SELECT value FROM jsonb_array_elements(read_resource_page_dependencies(w,k,i,'1')) LOOP
  admitted:=read_page_derivation_source(w,source->>'resourceKind',(source->>'resourceId')::uuid);
  IF admitted IS NULL OR admitted->>'version' IS DISTINCT FROM source->>'version' THEN RETURN NULL;END IF;
  required:=required||jsonb_build_array(source)||coalesce(admitted->'requiredSources','[]');
 END LOOP;
 RETURN root||jsonb_build_object('requiredSources',(SELECT coalesce(jsonb_agg(DISTINCT value),'[]') FROM jsonb_array_elements(required)));
END $$;
REVOKE ALL ON FUNCTION read_entity_derivation_source(uuid,text,uuid) FROM PUBLIC;

-- This function exposes no content. All independent/field/native/Page ancestors
-- must be currently admitted before the payload SELECT below can execute.
CREATE FUNCTION session_context_revision_allowed(w uuid,i uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE root jsonb;
BEGIN
 root:=read_entity_derivation_source(w,'session_context_revision',i);
 RETURN root IS NOT NULL AND root->>'held'='false'
  AND application_canonical_ancestry_allowed(w,'session_context_revision',i,'1') IS TRUE;
END $$;
REVOKE ALL ON FUNCTION session_context_revision_allowed(uuid,uuid) FROM PUBLIC;
CREATE FUNCTION read_session_context_revision(w uuid,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='session_context_revision_contents'::regclass
   WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
  OR session_context_revision_allowed(w,i) IS NOT TRUE THEN RETURN NULL;END IF;
 SELECT c.content INTO result FROM session_context_revision_contents c WHERE c.workspace_id=w AND c.revision_id=i;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION read_session_context_revision(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION guard_session_context_lineage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE output scope_derivations;
BEGIN
 IF TG_TABLE_NAME='scope_derivations' THEN output:=OLD;
 ELSE SELECT * INTO output FROM scope_derivations WHERE id=OLD.derivation_id AND workspace_id=OLD.workspace_id;END IF;
 IF output.resource_kind='session_context_revision' AND EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id)
  AND (TG_OP='DELETE' OR to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW)) THEN
  RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_session_context_lineage() FROM PUBLIC;
CREATE TRIGGER session_context_lineage_output BEFORE UPDATE OR DELETE ON scope_derivations FOR EACH ROW EXECUTE FUNCTION guard_session_context_lineage();
CREATE TRIGGER session_context_lineage_source BEFORE UPDATE OR DELETE ON scope_derivation_sources FOR EACH ROW EXECUTE FUNCTION guard_session_context_lineage();

CREATE FUNCTION validate_session_context_revision_pair() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE revision_id uuid;r session_context_scope_revisions;parent_row jsonb;payload jsonb;s sessions;
BEGIN
 IF TG_TABLE_NAME='session_context_scope_revisions' THEN revision_id:=NEW.id;
 ELSIF TG_TABLE_NAME='sessions' THEN
  IF TG_OP='UPDATE' AND NEW.compact_summary IS NOT DISTINCT FROM OLD.compact_summary
   AND NEW.compact_boundary_sequence IS NOT DISTINCT FROM OLD.compact_boundary_sequence
   AND NEW.compact_scope_revision_id IS NOT DISTINCT FROM OLD.compact_scope_revision_id THEN RETURN NULL;END IF;
  SELECT to_jsonb(p) INTO parent_row FROM sessions p WHERE p.id=NEW.id;
  IF parent_row IS NULL THEN RETURN NULL;END IF;
  revision_id:=(parent_row->>'compact_scope_revision_id')::uuid;
  IF revision_id IS NULL AND parent_row->>'compact_summary' IS NULL THEN RETURN NULL;END IF;
 ELSE
  IF TG_TABLE_NAME='session_state' THEN
   SELECT to_jsonb(p) INTO parent_row FROM session_state p WHERE p.id=NEW.id;
   IF TG_OP='UPDATE' AND NEW.scope_revision_id IS NOT DISTINCT FROM OLD.scope_revision_id AND
    (to_jsonb(NEW)-ARRAY['updated_at'])=(to_jsonb(OLD)-ARRAY['updated_at']) THEN RETURN NULL;END IF;
  ELSE
   SELECT to_jsonb(p) INTO parent_row FROM episodic_memories p WHERE p.id=NEW.id;
   IF TG_OP='UPDATE' AND NEW.scope_revision_id IS NOT DISTINCT FROM OLD.scope_revision_id AND
    (to_jsonb(NEW)-ARRAY['last_accessed_at','access_count','survival_count'])=(to_jsonb(OLD)-ARRAY['last_accessed_at','access_count','survival_count']) THEN RETURN NULL;END IF;
  END IF;
  IF parent_row IS NULL THEN RETURN NULL;END IF;
  revision_id:=(parent_row->>'scope_revision_id')::uuid;
 END IF;
 IF revision_id IS NULL THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 SELECT * INTO r FROM session_context_scope_revisions WHERE id=revision_id;
 IF TG_TABLE_NAME='sessions' AND (r.parent_kind IS DISTINCT FROM 'compact_summary' OR r.parent_id IS DISTINCT FROM NEW.id OR r.session_id IS DISTINCT FROM NEW.id)
  OR TG_TABLE_NAME='session_state' AND (r.parent_kind IS DISTINCT FROM 'session_state' OR r.parent_id IS DISTINCT FROM NEW.id OR r.session_id::text IS DISTINCT FROM parent_row->>'session_id')
  OR TG_TABLE_NAME='episodic_memories' AND (r.parent_kind IS DISTINCT FROM 'episodic_memory' OR r.parent_id IS DISTINCT FROM NEW.id OR r.session_id::text IS DISTINCT FROM parent_row->>'session_id') THEN
  RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='22023';END IF;
 SELECT * INTO s FROM sessions WHERE id=r.session_id AND workspace_id=r.workspace_id;
 SELECT c.content INTO payload FROM session_context_revision_contents c WHERE c.workspace_id=r.workspace_id AND c.revision_id=r.id;
 IF r.id IS NULL OR s.id IS NULL OR r.scope_held OR payload IS NULL
  OR NOT EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=r.workspace_id AND d.resource_kind='session_context_revision'
    AND d.resource_id=r.id AND d.resource_version='1' AND d.user_id IS NOT DISTINCT FROM r.user_id AND d.assistant_id IS NOT DISTINCT FROM r.assistant_id
    AND d.sensitivity=r.sensitivity AND d.compartments=r.compartments AND d.project_ids=r.project_ids
    AND EXISTS(SELECT 1 FROM scope_derivation_sources edge WHERE edge.workspace_id=d.workspace_id AND edge.derivation_id=d.id))
  OR r.user_id IS DISTINCT FROM (CASE WHEN s.visibility='personal' THEN s.user_id ELSE NULL END) OR r.assistant_id IS NOT NULL
 THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 IF r.parent_kind='compact_summary' THEN
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
REVOKE ALL ON FUNCTION validate_session_context_revision_pair() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER session_context_revision_pair AFTER INSERT ON session_context_scope_revisions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_session_context_revision_pair();
CREATE CONSTRAINT TRIGGER session_context_summary_pair AFTER INSERT OR UPDATE ON sessions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_session_context_revision_pair();
CREATE CONSTRAINT TRIGGER session_context_state_pair AFTER INSERT OR UPDATE ON session_state
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_session_context_revision_pair();
CREATE CONSTRAINT TRIGGER session_context_episode_pair AFTER INSERT OR UPDATE ON episodic_memories
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_session_context_revision_pair();

-- Raw parent readers must also prove source authority, before predicates/counts.
CREATE POLICY session_state_revision_floor ON session_state AS RESTRICTIVE FOR SELECT
 USING(scope_revision_id IS NOT NULL AND session_context_revision_allowed((SELECT workspace_id FROM sessions WHERE id=session_id),scope_revision_id));
CREATE POLICY episodic_revision_floor ON episodic_memories AS RESTRICTIVE FOR SELECT
 USING(scope_revision_id IS NOT NULL AND session_context_revision_allowed((SELECT workspace_id FROM sessions WHERE id=session_id),scope_revision_id));
DO $$ DECLARE definition text;before text;BEGIN
 SELECT pg_get_functiondef('validate_page_derivation_dependencies()'::regprocedure) INTO definition;
 before:='output.resource_kind NOT IN(''workspace_file'',''file_segment'')';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Page derivation output contract changed';END IF;
 EXECUTE replace(definition,before,'output.resource_kind NOT IN(''workspace_file'',''file_segment'',''session_context_revision'')');
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  GRANT EXECUTE ON FUNCTION session_personal_audience(sessions),session_workspace_audience(sessions),session_project_audience(sessions,boolean),
   session_context_revision_allowed(uuid,uuid),read_session_context_revision(uuid,uuid),read_admitted_native_scope_snapshot(uuid,text,uuid),read_entity_derivation_source(uuid,text,uuid) TO app_user;
 END IF;
END $$;

-- R2 extension contract: refresh only the reviewed compiled metadata kernel.
-- Source/field/actor admission is unchanged; unknown future kernel changes make
-- the runtime shortcut fall back to the complete walk.
DO $migration$
DECLARE kernel record;routine record;definition text;values_sql text:='';semantic_hash text;old_values text;
BEGIN
 FOR kernel IN SELECT * FROM (VALUES
  ('public.application_scope_source_edges(uuid,text,uuid,text)','20d8c359a6b77c9c96aed3be9e31719e60868fb55e34aaedc2714494e6a8e974'),
  ('public.scope_source_ancestors(uuid,text,uuid)','d8e33fb3a66e4318ed159e288c797b6d55759481e1339d4e53c372cb6907e0e8'),
  ('public.scope_source_ancestors_before_workflow_run(uuid,text,uuid)','36bdb461a66fb00b81a5f0f6672b48dcc150858328b035b1ba1da0c3ed3715c8'),
  ('public.scope_source_ancestors_before_browser_session(uuid,text,uuid)','c5a684292738319265321ce21b76ea01ba775eb216af66ae992c190d39eedc5c'),
  ('public.scope_source_ancestors_before_browser_profile(uuid,text,uuid)','497af5b78abd438a9332b52ba0e1eb6115997adfc447f239727d5948d626463a'),
  ('public.scope_source_table(text)','50b1e162e95c2cb9e01300d2ed70041cf89350004e11476352463eeba1e9d3d6'),
  ('public.scope_source_table_before_persistent_context(text)','77ae7215cf985148bc013cd5afd14cac03776580e347bf548c67b6d1ca7f40da'),
  ('public.scope_source_table_before_media(text)','93ff1be795bfbee59a38c43da3425018072c18007fe39e99ecd4d7e8731eba15')
 ) reviewed(signature,body_sha256) LOOP
  SELECT p.* INTO routine FROM pg_proc p WHERE p.oid=to_regprocedure(kernel.signature);
  IF NOT FOUND OR encode(sha256(convert_to(routine.prosrc,'UTF8')),'hex') IS DISTINCT FROM kernel.body_sha256 THEN
   RAISE EXCEPTION 'Canonical persistent context kernel changed: %',kernel.signature;END IF;
  semantic_hash:=application_field_digest(jsonb_build_object('name',routine.proname,'namespace',routine.pronamespace,'body',routine.prosrc,
   'config',routine.proconfig,'language',routine.prolang,'securityDefiner',routine.prosecdef,'volatility',routine.provolatile,'strict',routine.proisstrict,'parallel',routine.proparallel));
  values_sql:=values_sql||CASE WHEN values_sql='' THEN '' ELSE ',' END||format('(%s::oid,%L::text)',routine.oid,semantic_hash);
 END LOOP;
 SELECT pg_get_functiondef('application_scope_lineage(uuid,text[],uuid[],text[])'::regprocedure) INTO definition;
 SELECT substring(definition FROM 'FROM [(]VALUES ([^;]+)[)] pin[(]function_oid,fingerprint[)]') INTO old_values;
 IF old_values IS NULL OR position('count(*)=7 AND coalesce(bool_and' IN definition)=0
  OR position('R2 canonical entity leaf transport' IN definition)=0 THEN RAISE EXCEPTION 'Canonical native leaf shortcut changed';END IF;
 definition:=replace(definition,'FROM (VALUES '||old_values||') pin(function_oid,fingerprint)', 'FROM (VALUES '||values_sql||') pin(function_oid,fingerprint)');
 definition:=replace(definition,'count(*)=7 AND coalesce(bool_and','count(*)=8 AND coalesce(bool_and');
 EXECUTE definition;
END $migration$;

COMMIT;
