BEGIN;
-- Canonical media descendants participate in the existing exact-version graph.
ALTER TABLE scope_derivations DROP CONSTRAINT scope_derivations_resource_kind_check;
ALTER TABLE scope_derivations ADD CONSTRAINT scope_derivations_resource_kind_check CHECK(resource_kind IN
 ('memory','session_message','feedback_event','workspace_skill_revision','entity','entity_link','knowledge_entry','workspace_file','task','episode','recording','file_segment','transcript_segment'));
ALTER TABLE scope_derivation_sources DROP CONSTRAINT scope_derivation_sources_source_kind_check;
ALTER TABLE scope_derivation_sources ADD CONSTRAINT scope_derivation_sources_source_kind_check CHECK(source_kind IN
 ('memory','entity','entity_link','task','workspace_file','episode','knowledge_entry','kb_chunk','crm_event','memory_verification','brain_verification','correction_audit','session_message','feedback_event','workspace_skill_revision','knowledge_source','recording','file_segment','transcript_segment'));
ALTER FUNCTION scope_source_table(text) RENAME TO scope_source_table_before_media;
CREATE FUNCTION scope_source_table(k text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE k WHEN 'recording' THEN 'recordings' WHEN 'file_segment' THEN 'file_segments' WHEN 'transcript_segment' THEN 'transcript_segments' ELSE scope_source_table_before_media(k) END
$$;
REVOKE ALL ON FUNCTION scope_source_table(text) FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['recordings','file_segments','transcript_segments'] LOOP
  EXECUTE format('ALTER TABLE %I ADD COLUMN scope_version bigint NOT NULL DEFAULT 1, ADD COLUMN scope_held boolean NOT NULL DEFAULT false',t);
  EXECUTE format('CREATE POLICY media_scope_holding ON %I AS RESTRICTIVE FOR SELECT USING(NOT scope_held)',t);
 END LOOP;
END $$;
-- Shared file inheritance is valid, not an instruction to manufacture an assistant.
ALTER TABLE transcript_segments DROP CONSTRAINT transcript_segments_visibility_check;
ALTER TABLE recordings DROP CONSTRAINT IF EXISTS recordings_visibility_check;
ALTER TABLE episodes DROP CONSTRAINT IF EXISTS episodes_visibility_check;
ALTER TABLE episodes ADD CONSTRAINT episodes_visibility_check CHECK(user_id IS NOT NULL OR assistant_id IS NOT NULL OR source_kind='recording');
CREATE TABLE recording_intake_bindings (
 recording_id uuid PRIMARY KEY REFERENCES recordings(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 file_id uuid NOT NULL UNIQUE, file_version text NOT NULL
);
ALTER TABLE recording_intake_bindings ENABLE ROW LEVEL SECURITY;
CREATE POLICY recording_intake_binding_read ON recording_intake_bindings FOR SELECT USING(
 EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=recording_intake_bindings.workspace_id AND user_id=nullif(current_setting('app.current_user_id',true),'')::uuid));

CREATE FUNCTION media_intake_source(w uuid,i uuid,expected jsonb) RETURNS workspace_files
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f workspace_files; s jsonb;
BEGIN
 PERFORM 1 FROM workspaces WHERE id=w FOR UPDATE;
 s:=read_entity_derivation_source(w,'workspace_file',i);
 IF s IS NULL OR s->>'held' IS DISTINCT FROM 'false' OR s->>'validTo' IS NOT NULL OR s->>'retractedAt' IS NOT NULL
  OR expected->>'resourceKind' IS DISTINCT FROM 'workspace_file' OR expected->>'resourceId' IS DISTINCT FROM i::text
  OR expected->>'workspaceId' IS DISTINCT FROM w::text OR s->>'version' IS DISTINCT FROM expected->>'version'
  OR s->'userId' IS DISTINCT FROM expected->'userId' OR s->'assistantId' IS DISTINCT FROM expected->'assistantId'
  OR s->'sensitivity' IS DISTINCT FROM expected->'sensitivity' OR s->'compartments' IS DISTINCT FROM expected->'compartments'
  OR s->'projectIds' IS DISTINCT FROM expected->'projectIds'
  OR scope_review_state_held('workspace_file',i) OR NOT file_session_binding_allows(i) OR NOT pdf_intake_file_visible(i) OR NOT office_output_file_allows(i,false) OR NOT recording_transcript_file_allows(i)
 THEN RAISE EXCEPTION 'recording_intake_source_changed'; END IF;
 SELECT * INTO f FROM workspace_files WHERE workspace_id=w AND id=i FOR SHARE;
 RETURN f;
END $$;
REVOKE ALL ON FUNCTION media_intake_source(uuid,uuid,jsonb) FROM PUBLIC;
CREATE FUNCTION record_media_lineage(w uuid,k text,i uuid,sk text,si uuid,sv text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s jsonb; d uuid;
BEGIN
 s:=read_scope_source(w,k,i);
 INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
 SELECT w,k,i,s->>'version','canonical-media-intake',(s->>'userId')::uuid,(s->>'assistantId')::uuid,s->>'sensitivity',
 ARRAY(SELECT jsonb_array_elements_text(s->'compartments')),ARRAY(SELECT jsonb_array_elements_text(s->'projectIds')::uuid),revision
 FROM workspace_access_policies WHERE workspace_id=w
 ON CONFLICT(workspace_id,resource_kind,resource_id,resource_version) DO UPDATE SET producer=EXCLUDED.producer RETURNING id INTO d;
 IF d IS NULL THEN RAISE EXCEPTION 'scope_evidence_missing'; END IF;
 INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version) VALUES(w,d,sk,si,sv) ON CONFLICT DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION record_media_lineage(uuid,text,uuid,text,uuid,text) FROM PUBLIC;

CREATE FUNCTION publish_file_recording(expected jsonb,requested_id uuid) RETURNS SETOF recordings
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f workspace_files; r recordings; b recording_intake_bindings; actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid; key text;
BEGIN
 f:=media_intake_source((expected->>'workspaceId')::uuid,(expected->>'resourceId')::uuid,expected);
 IF f.mime NOT LIKE 'audio/%' AND f.mime NOT LIKE 'video/%' THEN RAISE EXCEPTION 'recording_media_required'; END IF;
 SELECT * INTO b FROM recording_intake_bindings WHERE file_id=f.id;
 IF FOUND THEN
  SELECT * INTO r FROM recordings WHERE id=b.recording_id AND workspace_id=f.workspace_id;
  IF b.file_version IS DISTINCT FROM expected->>'version' OR r.scope_held OR r.valid_to IS NOT NULL OR r.retracted_at IS NOT NULL
    OR scope_review_state_held('recording',r.id) OR NOT EXISTS(SELECT 1 FROM scope_derivations WHERE resource_kind='recording' AND resource_id=r.id AND resource_version=r.scope_version::text) THEN RAISE EXCEPTION 'recording_intake_source_changed'; END IF;
  RETURN NEXT r; RETURN;
 END IF;
 -- Only canonical storage locations, never a caller-supplied gcsKey/source_ref.
 IF f.storage_uri !~ '^(gs|s3|az|file)://' THEN RAISE EXCEPTION 'recording_storage_binding_required'; END IF;
 IF f.storage_uri ~ '^file:///' THEN
  key:=substring(f.storage_uri FROM '/([^/]+/[^/]+)$');
 ELSE key:=regexp_replace(f.storage_uri,'^[a-z]+://[^/]+/',''); END IF;
 IF key IS NULL OR key='' OR key=f.storage_uri THEN RAISE EXCEPTION 'recording_storage_binding_required'; END IF;
 PERFORM set_config('app.media_intake_parent',expected::text,true);
 INSERT INTO episodes(id,workspace_id,source_kind,source_ref,occurred_at,user_id,assistant_id,sensitivity,compartments,project_ids,created_by_user_id)
 VALUES(requested_id,f.workspace_id,'recording',jsonb_build_object('fileId',f.id,'gcsKey',key,'storageUri',f.storage_uri,'mime',f.mime,'fileName',f.name),now(),f.user_id,f.assistant_id,f.sensitivity,f.compartments,f.project_ids,actor);
 INSERT INTO recordings(id,workspace_id,mime,gcs_key,storage_uri,file_name,title,bytes,media_file_id,user_id,assistant_id,sensitivity,compartments,project_ids,created_by_user_id)
 VALUES(requested_id,f.workspace_id,f.mime,key,f.storage_uri,f.name,coalesce(f.title,f.name),f.size_bytes,f.id,f.user_id,f.assistant_id,f.sensitivity,f.compartments,f.project_ids,actor) RETURNING * INTO r;
 INSERT INTO recording_intake_bindings VALUES(r.id,f.workspace_id,f.id,expected->>'version');
 PERFORM record_media_lineage(f.workspace_id,'episode',r.id,'workspace_file',f.id,expected->>'version');
 PERFORM record_media_lineage(f.workspace_id,'recording',r.id,'workspace_file',f.id,expected->>'version');
 PERFORM record_media_lineage(f.workspace_id,'recording',r.id,'episode',r.id,(read_scope_source(f.workspace_id,'episode',r.id))->>'version');
 PERFORM set_config('app.media_intake_parent','',true);
 RETURN NEXT r;
END $$;

CREATE FUNCTION publish_media_segments(expected jsonb,recording uuid,recording_version text,episode_version text,segments jsonb,replace_existing boolean DEFAULT false) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f workspace_files; r recordings; e jsonb; item jsonb; sid uuid; old_row jsonb; n integer:=0;
 actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid; k text;
BEGIN
 f:=media_intake_source((expected->>'workspaceId')::uuid,(expected->>'resourceId')::uuid,expected);
 IF recording IS NOT NULL THEN
  SELECT * INTO r FROM recordings WHERE id=recording AND workspace_id=f.workspace_id FOR SHARE;
  e:=read_entity_derivation_source(f.workspace_id,'episode',recording);
  IF r.id IS NULL OR r.scope_held OR r.scope_version::text IS DISTINCT FROM recording_version OR r.valid_to IS NOT NULL OR r.retracted_at IS NOT NULL
   OR r.media_file_id IS DISTINCT FROM f.id OR r.storage_uri IS DISTINCT FROM f.storage_uri
   OR r.user_id IS DISTINCT FROM f.user_id OR r.assistant_id IS DISTINCT FROM f.assistant_id OR r.sensitivity IS DISTINCT FROM f.sensitivity
   OR r.compartments IS DISTINCT FROM f.compartments OR r.project_ids IS DISTINCT FROM f.project_ids
   OR e->'userId' IS DISTINCT FROM to_jsonb(f)->'user_id' OR e->'assistantId' IS DISTINCT FROM to_jsonb(f)->'assistant_id'
   OR e->>'sensitivity' IS DISTINCT FROM f.sensitivity OR e->'compartments' IS DISTINCT FROM to_jsonb(f.compartments) OR e->'projectIds' IS DISTINCT FROM to_jsonb(f.project_ids)
   OR e IS NULL OR e->>'version' IS DISTINCT FROM episode_version OR e->>'held' IS DISTINCT FROM 'false'
   OR scope_review_state_held('recording',recording) OR scope_review_state_held('episode',recording)
   OR NOT EXISTS(SELECT 1 FROM recording_intake_bindings WHERE recording_id=recording AND file_id=f.id AND file_version=expected->>'version')
   OR NOT EXISTS(SELECT 1 FROM scope_derivations d JOIN scope_derivation_sources ds ON ds.derivation_id=d.id
     WHERE d.resource_kind='recording' AND d.resource_id=recording AND d.resource_version=recording_version
      AND ds.source_kind='workspace_file' AND ds.source_id=f.id AND ds.source_version=expected->>'version')
   OR NOT EXISTS(SELECT 1 FROM scope_derivations d JOIN scope_derivation_sources ds ON ds.derivation_id=d.id
     WHERE d.resource_kind='episode' AND d.resource_id=recording AND d.resource_version=episode_version
      AND ds.source_kind='workspace_file' AND ds.source_id=f.id AND ds.source_version=expected->>'version')
   THEN RAISE EXCEPTION 'recording_intake_source_changed'; END IF;
  IF replace_existing THEN RAISE EXCEPTION 'transcript_replace_not_supported'; END IF;
  k:='transcript_segment';
 ELSE k:='file_segment'; END IF;
 PERFORM set_config('app.media_intake_parent',expected::text,true);
 IF replace_existing THEN DELETE FROM file_segments WHERE file_id=f.id AND workspace_id=f.workspace_id; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(segments) LOOP
  sid:=NULL;
  IF recording IS NULL THEN
   SELECT to_jsonb(s) INTO old_row FROM file_segments s WHERE file_id=f.id AND segment_index=(item->>'segmentIndex')::int;
   IF old_row IS NOT NULL THEN
    IF old_row->>'content' IS DISTINCT FROM item->>'content' OR (old_row->>'char_start')::int IS DISTINCT FROM (item->>'charStart')::int
     OR (old_row->>'char_end')::int IS DISTINCT FROM (item->>'charEnd')::int OR old_row->'heading_path' IS DISTINCT FROM item->'headingPath'
     OR (old_row->>'scope_held')::boolean OR old_row->>'valid_to' IS NOT NULL OR old_row->>'retracted_at' IS NOT NULL
     OR NOT EXISTS(SELECT 1 FROM scope_derivations d JOIN scope_derivation_sources ds ON ds.derivation_id=d.id WHERE d.resource_kind=k AND d.resource_id=(old_row->>'id')::uuid AND ds.source_kind='workspace_file' AND ds.source_id=f.id AND ds.source_version=expected->>'version') THEN RAISE EXCEPTION 'segment_idempotency_conflict'; END IF;
    CONTINUE;
   END IF;
   INSERT INTO file_segments(workspace_id,file_id,segment_index,char_start,char_end,heading_path,content,user_id,assistant_id,source,sensitivity,compartments,project_ids,tags,created_by_user_id)
   VALUES(f.workspace_id,f.id,(item->>'segmentIndex')::int,(item->>'charStart')::int,(item->>'charEnd')::int,ARRAY(SELECT jsonb_array_elements_text(item->'headingPath')),item->>'content',f.user_id,f.assistant_id,f.source,f.sensitivity,f.compartments,f.project_ids,f.tags,actor) RETURNING id INTO sid;
  ELSE
   SELECT to_jsonb(s) INTO old_row FROM transcript_segments s WHERE recording_id=recording AND segment_index=(item->>'segmentIndex')::int;
   IF old_row IS NOT NULL THEN
    IF old_row->>'segment_text' IS DISTINCT FROM item->>'text' OR (old_row->>'start_ms')::bigint IS DISTINCT FROM (item->>'startMs')::bigint
     OR (old_row->>'end_ms')::bigint IS DISTINCT FROM (item->>'endMs')::bigint OR old_row->>'speaker' IS DISTINCT FROM item->>'speaker'
     OR old_row->'speaker_ids' IS DISTINCT FROM item->'speakerIds' OR old_row->'utterance_refs' IS DISTINCT FROM item->'utteranceRefs' OR old_row->>'kind' IS DISTINCT FROM coalesce(item->>'kind','speech')
     OR (old_row->>'scope_held')::boolean OR old_row->>'valid_to' IS NOT NULL OR old_row->>'retracted_at' IS NOT NULL
     OR NOT EXISTS(SELECT 1 FROM scope_derivations d JOIN scope_derivation_sources ds ON ds.derivation_id=d.id WHERE d.resource_kind=k AND d.resource_id=(old_row->>'id')::uuid AND ds.source_kind='workspace_file' AND ds.source_id=f.id AND ds.source_version=expected->>'version') THEN RAISE EXCEPTION 'segment_idempotency_conflict'; END IF;
    CONTINUE;
   END IF;
   INSERT INTO transcript_segments(workspace_id,recording_id,segment_index,start_ms,end_ms,speaker,speaker_ids,segment_text,utterance_refs,user_id,assistant_id,source,sensitivity,compartments,project_ids,created_by_user_id,kind)
   VALUES(f.workspace_id,recording,(item->>'segmentIndex')::int,(item->>'startMs')::bigint,(item->>'endMs')::bigint,item->>'speaker',ARRAY(SELECT jsonb_array_elements_text(item->'speakerIds')),item->>'text',item->'utteranceRefs',f.user_id,f.assistant_id,'recording',f.sensitivity,f.compartments,f.project_ids,actor,coalesce(item->>'kind','speech')) RETURNING id INTO sid;
  END IF;
  PERFORM record_media_lineage(f.workspace_id,k,sid,'workspace_file',f.id,expected->>'version');
  IF recording IS NOT NULL THEN
   PERFORM record_media_lineage(f.workspace_id,k,sid,'recording',recording,recording_version);
   PERFORM record_media_lineage(f.workspace_id,k,sid,'episode',recording,episode_version);
  END IF;
  n:=n+1;
 END LOOP;
 PERFORM set_config('app.media_intake_parent','',true);
 RETURN n;
END $$;

ALTER FUNCTION hold_scope_descendants(uuid,text,uuid) RENAME TO hold_scope_descendants_before_media;
CREATE FUNCTION hold_scope_descendants(w uuid,k text,i uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t text; ids uuid[];
BEGIN
 PERFORM hold_scope_descendants_before_media(w,k,i);
 FOR t IN SELECT unnest(ARRAY['episode','recording','file_segment','transcript_segment']) LOOP
  WITH RECURSIVE descendants(kind,id) AS (
   SELECT d.resource_kind,d.resource_id FROM scope_derivation_sources s JOIN scope_derivations d ON d.id=s.derivation_id WHERE s.workspace_id=w AND s.source_kind=k AND s.source_id=i
   UNION SELECT d.resource_kind,d.resource_id FROM descendants p JOIN scope_derivation_sources s ON s.workspace_id=w AND s.source_kind=p.kind AND s.source_id=p.id JOIN scope_derivations d ON d.id=s.derivation_id
  ) SELECT array_agg(id) INTO ids FROM descendants WHERE kind=t;
  EXECUTE format('UPDATE %I SET scope_held=true WHERE workspace_id=$1 AND id=ANY($2) AND NOT scope_held',scope_source_table(t)) USING w,ids;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION hold_scope_descendants(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION media_semantic_row(r jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT entity_scope_semantic_row(r)-ARRAY['status','duration_ms','participants','truncated','last_error','delete_after','transcript_file_id',
 'detected_language','detected_language_confidence','canto_density_per_k','canto_marker_count','cjk_count','latin_tokens','chinese_variant']
$$;
-- Trigger-only elevation, matching advance_derived_file_version: helpers stay
-- non-executable by the app role; only the already-authorized NEW row is changed.
CREATE FUNCTION advance_media_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN
 IF media_semantic_row(to_jsonb(NEW)) IS DISTINCT FROM media_semantic_row(to_jsonb(OLD)) THEN NEW.scope_version:=OLD.scope_version+1;
 ELSE NEW.scope_version:=OLD.scope_version; END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION media_semantic_row(jsonb),advance_media_version() FROM PUBLIC;
CREATE FUNCTION invalidate_media_source() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN PERFORM hold_scope_descendants(OLD.workspace_id,TG_ARGV[0],OLD.id); END IF;
  RETURN OLD;
 END IF;
 IF (media_semantic_row(to_jsonb(NEW))-'scope_held') IS DISTINCT FROM (media_semantic_row(to_jsonb(OLD))-'scope_held')
  OR (NOT OLD.scope_held AND NEW.scope_held AND pg_trigger_depth()=1) THEN PERFORM hold_scope_descendants(OLD.workspace_id,TG_ARGV[0],OLD.id); END IF;
 RETURN NULL;
END $$;
DO $$ DECLARE k text; t text; BEGIN
 FOREACH k IN ARRAY ARRAY['recording','file_segment','transcript_segment'] LOOP
  t:=scope_source_table(k);
  EXECUTE format('CREATE TRIGGER canonical_scope_version BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION advance_media_version()',t);
  EXECUTE format('CREATE TRIGGER invalidate_media AFTER UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION invalidate_media_source(%L)',t,k);
  EXECUTE format('CREATE TRIGGER invalidate_deleted_media BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION invalidate_media_source(%L)',t,k);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION invalidate_media_source() FROM PUBLIC;
-- Ready-mode raw writers cannot bypass canonical source validation or commit
-- an output without exact lineage. Deferred validation shares the output tx.
CREATE FUNCTION guard_media_publication() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE expected jsonb; f workspace_files; b jsonb:=to_jsonb(NEW);
BEGIN
 IF NOT EXISTS(SELECT 1 FROM workspace_access_policies WHERE workspace_id=NEW.workspace_id AND setup_state='ready') THEN RETURN NEW; END IF;
 expected:=nullif(current_setting('app.media_intake_parent',true),'')::jsonb;
 IF expected IS NULL THEN RAISE EXCEPTION 'recording_intake_provenance_required'; END IF;
 f:=media_intake_source(NEW.workspace_id,(expected->>'resourceId')::uuid,expected);
 IF b->'user_id' IS DISTINCT FROM to_jsonb(f)->'user_id' OR b->'assistant_id' IS DISTINCT FROM to_jsonb(f)->'assistant_id'
  OR b->>'sensitivity' IS DISTINCT FROM f.sensitivity OR b->'compartments' IS DISTINCT FROM to_jsonb(f.compartments)
  OR b->'project_ids' IS DISTINCT FROM to_jsonb(f.project_ids)
  OR (TG_ARGV[0]='file_segment' AND b->>'file_id' IS DISTINCT FROM f.id::text)
  OR (TG_ARGV[0]='recording' AND b->>'media_file_id' IS DISTINCT FROM f.id::text)
  OR (TG_ARGV[0]='transcript_segment' AND NOT EXISTS(SELECT 1 FROM recording_intake_bindings WHERE recording_id=(b->>'recording_id')::uuid AND file_id=f.id AND file_version=expected->>'version'))
 THEN RAISE EXCEPTION 'recording_intake_source_changed'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION require_media_lineage() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM workspace_access_policies WHERE workspace_id=NEW.workspace_id AND setup_state='ready')
  AND NOT EXISTS(SELECT 1 FROM scope_derivations d JOIN scope_derivation_sources s ON s.derivation_id=d.id
   WHERE d.workspace_id=NEW.workspace_id AND d.resource_kind=TG_ARGV[0] AND d.resource_id=NEW.id AND s.source_kind='workspace_file')
 THEN RAISE EXCEPTION 'media_lineage_required'; END IF;
 RETURN NULL;
END $$;
-- Primitive metadata reads must not invoke any lineage policy. The shared
-- validator below traverses the graph itself, avoiding mutual policy recursion.
ALTER FUNCTION read_entity_derivation_source(uuid,text,uuid) RENAME TO read_entity_derivation_source_before_recordings;
REVOKE ALL ON FUNCTION read_entity_derivation_source_before_recordings(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_media_parent_snapshot(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s jsonb; e jsonb;
BEGIN
 IF k='workspace_file' AND (file_session_binding_allows(i) IS NOT TRUE
  OR pdf_intake_file_visible(i) IS NOT TRUE OR office_output_file_allows(i,false) IS NOT TRUE) THEN RETURN NULL; END IF;
 IF k<>'recording' THEN RETURN read_entity_derivation_source_before_recordings(w,k,i); END IF;
 e:=read_entity_derivation_source_before_recordings(w,'episode',i);
 IF e IS NULL OR e->>'held' IS DISTINCT FROM 'false' OR e->>'validTo' IS NOT NULL OR e->>'retractedAt' IS NOT NULL
  OR scope_review_state_held('episode',i) THEN RETURN NULL; END IF;
 s:=read_scope_source(w,k,i);
 IF s IS NULL OR s->'userId' IS DISTINCT FROM e->'userId' OR s->'assistantId' IS DISTINCT FROM e->'assistantId'
  OR s->'sensitivity' IS DISTINCT FROM e->'sensitivity' OR s->'compartments' IS DISTINCT FROM e->'compartments'
  OR s->'projectIds' IS DISTINCT FROM e->'projectIds'
  OR NOT EXISTS(SELECT 1 FROM recording_intake_bindings b JOIN scope_derivations d ON d.resource_kind='recording' AND d.resource_id=b.recording_id
    WHERE b.workspace_id=w AND b.recording_id=i AND d.resource_version=s->>'version') THEN RETURN NULL; END IF;
 RETURN s;
END $$;
REVOKE ALL ON FUNCTION read_media_parent_snapshot(uuid,text,uuid) FROM PUBLIC;

-- Iterative depth-first traversal: active nodes detect cycles; completed nodes
-- deduplicate diamonds without skipping a conflicting version. Every ancestor
-- is checked under the current actor, including review-only holds and live
-- Office/PDF/session bindings. No recursive calls through RLS/read wrappers.
CREATE FUNCTION media_parent_visible(k text,i uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE w uuid; pending jsonb; item jsonb; source record; snapshot jsonb;
 key text; active text[]:='{}'; completed jsonb:='{}'; visits integer:=0;
BEGIN
 SELECT workspace_id INTO w FROM scope_derivations WHERE resource_kind=k AND resource_id=i LIMIT 1;
 IF w IS NULL THEN RETURN true; END IF;
 pending:=jsonb_build_array(jsonb_build_object('kind',k,'id',i,'version','root','root',true));
 WHILE jsonb_array_length(pending)>0 LOOP
  item:=pending->(jsonb_array_length(pending)-1); pending:=pending-(jsonb_array_length(pending)-1);
  key:=(item->>'kind')||':'||(item->>'id');
  IF coalesce((item->>'leave')::boolean,false) THEN
   active:=array_remove(active,key); completed:=completed||jsonb_build_object(key,item->>'version'); CONTINUE;
  END IF;
  IF key=ANY(active) THEN RETURN false; END IF;
  IF completed ? key THEN
   IF completed->>key IS DISTINCT FROM item->>'version' THEN RETURN false; END IF;
   CONTINUE;
  END IF;
  visits:=visits+1;
  IF visits>4096 THEN RETURN false; END IF;
  IF NOT coalesce((item->>'root')::boolean,false) THEN
   snapshot:=read_media_parent_snapshot(w,item->>'kind',(item->>'id')::uuid);
   IF snapshot IS NULL OR snapshot->>'held' IS DISTINCT FROM 'false' OR snapshot->>'validTo' IS NOT NULL OR snapshot->>'retractedAt' IS NOT NULL
    OR snapshot->>'workspaceId' IS DISTINCT FROM w::text OR snapshot->>'version' IS DISTINCT FROM item->>'version'
    OR scope_review_state_held(item->>'kind',(item->>'id')::uuid) THEN RETURN false; END IF;
   IF item->>'kind'='workspace_file' AND (
     file_session_binding_allows((item->>'id')::uuid) IS NOT TRUE
     OR pdf_intake_file_visible((item->>'id')::uuid) IS NOT TRUE
     OR office_output_file_allows((item->>'id')::uuid,false) IS NOT TRUE) THEN RETURN false; END IF;
  END IF;
  active:=array_append(active,key);
  pending:=pending||jsonb_build_array(item||'{"leave":true}'::jsonb);
  FOR source IN SELECT ds.* FROM scope_derivations d JOIN scope_derivation_sources ds ON ds.derivation_id=d.id AND ds.workspace_id=d.workspace_id
   WHERE d.workspace_id=w AND d.resource_kind=item->>'kind' AND d.resource_id=(item->>'id')::uuid
   ORDER BY ds.source_kind DESC,ds.source_id DESC LOOP
   pending:=pending||jsonb_build_array(jsonb_build_object('kind',source.source_kind,'id',source.source_id,'version',source.source_version));
  END LOOP;
 END LOOP;
 RETURN true;
END $$;
DO $$ DECLARE k text; t text; BEGIN
 FOREACH k IN ARRAY ARRAY['recording','file_segment','transcript_segment'] LOOP
  t:=scope_source_table(k);
  EXECUTE format('CREATE TRIGGER zzzz_media_publication BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION guard_media_publication(%L)',t,k);
  EXECUTE format('CREATE CONSTRAINT TRIGGER media_lineage AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_media_lineage(%L)',t,k);
  EXECUTE format('CREATE POLICY live_media_parent ON %I AS RESTRICTIVE FOR SELECT USING(media_parent_visible(%L,id))',t,k);
 END LOOP;
END $$;
CREATE POLICY live_recording_episode_parent ON episodes AS RESTRICTIVE FOR SELECT USING(media_parent_visible('episode',id));
REVOKE ALL ON FUNCTION guard_media_publication(),require_media_lineage() FROM PUBLIC;
-- Generic derived-file publication uses the same closed metadata reader for a
-- recording source; do not expose the unscoped canonical reader to the app role.
CREATE FUNCTION read_entity_derivation_source(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s jsonb;
BEGIN
 s:=read_media_parent_snapshot(w,k,i);
 IF k IN('recording','episode','workspace_file') AND (s IS NULL OR s->>'held' IS DISTINCT FROM 'false'
  OR s->>'validTo' IS NOT NULL OR s->>'retractedAt' IS NOT NULL OR scope_review_state_held(k,i)
  OR NOT media_parent_visible(k,i)) THEN RETURN NULL; END IF;
 RETURN s;
END $$;
-- Transcript bytes also retain live parent ACLs, not only materialized holds.
CREATE FUNCTION recording_transcript_file_allows(i uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT media_parent_visible('workspace_file',i)
$$;
CREATE POLICY recording_transcript_live_parent ON workspace_files AS RESTRICTIVE FOR SELECT USING(recording_transcript_file_allows(id));
COMMIT;
