BEGIN;
ALTER TABLE office_artifacts ADD COLUMN pdf_intake_state text NOT NULL DEFAULT 'ready'
 CHECK(pdf_intake_state IN ('pending','ready','abandoned')),
 ADD COLUMN pdf_intake_sources jsonb,
 ADD COLUMN pdf_intake_request_hash text;
-- Session delivery retains the exact source proof after publication, too.
CREATE FUNCTION pdf_intake_sources_current(artifact uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE sources jsonb; w uuid; expected jsonb; current_row jsonb;
BEGIN
 SELECT pdf_intake_sources,workspace_id INTO sources,w FROM office_artifacts WHERE id=artifact;
 IF sources IS NULL THEN RETURN true; END IF;
 IF jsonb_array_length(sources)=0 THEN RETURN false; END IF;
 FOR expected IN SELECT value FROM jsonb_array_elements(sources) LOOP
  current_row:=NULL;
  IF expected->>'kind'='workspace_file' THEN
   SELECT to_jsonb(f) INTO current_row FROM workspace_files f WHERE f.id=(expected->>'resourceId')::uuid AND f.workspace_id=w;
  ELSIF expected->>'kind'='file_cache' THEN
   SELECT to_jsonb(f) INTO current_row FROM file_cache f WHERE f.id=(expected->>'resourceId')::uuid AND f.workspace_id=w
    AND EXISTS(SELECT 1 FROM sessions s JOIN assistants a ON a.id=s.assistant_id WHERE s.id=f.session_id AND s.user_id=f.user_id
      AND s.workspace_id=w AND a.workspace_id=w AND coalesce(s.context_compartments,'{}') <@ f.compartments
      AND (s.context_project_id IS NULL OR s.context_project_id=ANY(f.project_ids)));
  ELSE RETURN false; END IF;
  IF current_row IS NULL OR encode(sha256(convert_to(current_row::text,'UTF8')),'hex') IS DISTINCT FROM expected->>'version'
   OR (current_row->>'scope_held')::boolean IS DISTINCT FROM false
   OR current_row->>'valid_to' IS NOT NULL OR current_row->>'retracted_at' IS NOT NULL
   OR (current_row->>'expires_at' IS NOT NULL AND (current_row->>'expires_at')::timestamptz<=now())
   OR scope_review_state_held(expected->>'kind',(expected->>'resourceId')::uuid) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
-- SECURITY DEFINER child authorization bypasses root RLS. Share this gate
-- between root/file delivery and the canonical child predicate, including its
-- nested thread/job/audit callers. A pending exception is exact-root, owner-only,
-- and never exempts source validity (nor abandoned/invalid published roots).
CREATE FUNCTION pdf_intake_artifact_allows(artifact uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM office_artifacts a WHERE a.id=artifact
   AND pdf_intake_sources_current(a.id)
   AND (a.pdf_intake_state='ready' OR (
     a.pdf_intake_state='pending' AND a.pdf_intake_sources IS NOT NULL
     AND a.id::text=current_setting('app.pdf_intake_artifact',true)
     AND a.owner_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid)))
$$;
CREATE OR REPLACE FUNCTION office_artifact_scope_allows(artifact uuid,w uuid,mutation boolean DEFAULT false)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM office_artifacts a WHERE a.id=artifact AND a.workspace_id=w
   AND NOT scope_review_state_held('office_artifact',a.id)
   AND pdf_intake_artifact_allows(a.id)
   AND (a.mode<>'session' OR (
     a.owner_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
     AND a.lifecycle_state='active' AND now()<a.expires_at
     AND a.family='pdf' AND a.default_workspace_role='deny'
   ))
   AND office_root_scope_allows(a.id,a.workspace_id,a.sensitivity,a.compartments,a.project_ids,
     a.visibility_user_ids,a.visibility_assistant_ids,mutation))
$$;
CREATE POLICY pdf_intake_visibility ON office_artifacts AS RESTRICTIVE FOR SELECT
 USING(pdf_intake_sources_current(id) AND (pdf_intake_state='ready' OR (
   pdf_intake_state='pending' AND pdf_intake_sources IS NOT NULL
   AND id::text=current_setting('app.pdf_intake_artifact',true)
   AND owner_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid)));
CREATE FUNCTION pdf_intake_file_visible(file uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM workspace_file_session_bindings b JOIN office_artifacts a ON a.id=b.artifact_id
 WHERE b.file_id=file AND NOT pdf_intake_artifact_allows(a.id))
$$;
CREATE POLICY pdf_intake_file_visibility ON workspace_files AS RESTRICTIVE FOR SELECT USING(pdf_intake_file_visible(id));
-- A failed/uncertain caller may abandon ONLY a still-pending root it owns.
-- Published sessions are never rolled back by a lost commit acknowledgement.
CREATE FUNCTION abandon_pdf_intake(target uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE changed uuid;
BEGIN
 UPDATE office_artifacts SET pdf_intake_state='abandoned',pdf_session_idempotency_key=NULL,
   created_at=now()-interval '24 hours 1 second',expires_at=now()-interval '1 second'
 WHERE id=target AND mode='session' AND pdf_intake_state='pending'
 AND owner_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid RETURNING id INTO changed;
 RETURN changed IS NOT NULL;
END $$;
-- Proof/ownership cannot be rebound by a later metadata edit.
CREATE FUNCTION preserve_pdf_intake_binding() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.pdf_intake_sources IS NOT NULL AND (
   NEW.pdf_intake_sources IS DISTINCT FROM OLD.pdf_intake_sources
   OR NEW.pdf_intake_request_hash IS DISTINCT FROM OLD.pdf_intake_request_hash
   OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
   OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
   OR NEW.mode IS DISTINCT FROM OLD.mode OR NEW.family IS DISTINCT FROM OLD.family
   OR (OLD.pdf_intake_state<>'pending' AND NEW.pdf_intake_state IS DISTINCT FROM OLD.pdf_intake_state)
 ) THEN RAISE EXCEPTION 'pdf_intake_binding_immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER preserve_pdf_intake_binding BEFORE UPDATE ON office_artifacts
FOR EACH ROW EXECUTE FUNCTION preserve_pdf_intake_binding();
COMMIT;
