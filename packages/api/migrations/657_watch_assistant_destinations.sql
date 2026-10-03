-- A watch may record to any assistant its owner can use in a workspace, not only
-- the primary. Each destination assistant gets its own grant, so changing the
-- selection never revokes (and strands) captures queued on an earlier grant.
-- Spec: docs/watch-recording-api.md -> "Watch grants".
BEGIN;
DROP INDEX recording_device_provisioning_identity;
CREATE UNIQUE INDEX recording_device_provisioning_identity ON recording_device_grants(owner_id,device_id,workspace_id,assistant_id) WHERE revoked_at IS NULL;
-- Frozen when the capture is created: NULL is workspace-shared root media (a
-- primary destination, and every capture created before this migration);
-- otherwise the destination assistant's partition. The grant's assistant never
-- changes, so this only pins the kind decision against later retries.
ALTER TABLE watch_captures ADD COLUMN scope_assistant_id uuid;
CREATE OR REPLACE FUNCTION stamp_watch_capture_occurred_at() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c watch_captures; g recording_device_grants;
BEGIN
 SELECT * INTO c FROM watch_captures WHERE recording_id=NEW.id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 SELECT * INTO g FROM recording_device_grants WHERE id=c.grant_id;
 IF c.state <> 'sealed' OR c.expires_at<=clock_timestamp() OR g.revoked_at IS NOT NULL
   OR NEW.workspace_id IS DISTINCT FROM g.workspace_id
   -- Human-recorded root media carries exactly the capture's frozen partition.
   OR NEW.assistant_id IS DISTINCT FROM c.scope_assistant_id
   OR (c.scope_assistant_id IS NOT NULL AND c.scope_assistant_id IS DISTINCT FROM g.assistant_id)
   OR NEW.created_by_user_id IS DISTINCT FROM g.owner_id
   OR nullif(current_setting('app.current_user_id',true),'')::uuid IS DISTINCT FROM g.owner_id
   OR nullif(current_setting('app.media_intake_parent',true),'') IS NULL
 THEN RAISE EXCEPTION 'watch_recording_provenance_mismatch'; END IF;
 NEW.occurred_at := (c.metadata->>'capturedAt')::timestamptz;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION stamp_watch_capture_occurred_at() FROM PUBLIC;
CREATE OR REPLACE FUNCTION guard_watch_capture_publication() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c watch_captures; g recording_device_grants; actor uuid;
BEGIN
 IF TG_TABLE_NAME='workspace_files' THEN
  SELECT * INTO c FROM watch_captures WHERE id=substring(NEW.path FROM '^/recordings/watch/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[.]m4a$')::uuid;
  IF NOT FOUND THEN RETURN NEW; END IF;
  actor:=NEW.created_by_user_id;
  IF c.state<>'sealed' THEN RAISE EXCEPTION 'watch_capture_publication_closed'; END IF;
  -- Device audio is human-authored and lands in the capture's frozen partition.
  IF NEW.assistant_id IS DISTINCT FROM c.scope_assistant_id OR NEW.created_by_assistant_id IS NOT NULL
    THEN RAISE EXCEPTION 'watch_capture_publication_closed'; END IF;
 ELSE
  SELECT * INTO c FROM watch_captures WHERE page_id=NEW.id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  actor:=NEW.created_by;
  IF TG_OP='INSERT' AND (c.page_prepared OR NOT c.page_prepare_started OR c.state<>'open')
    THEN RAISE EXCEPTION 'watch_page_already_prepared'; END IF;
  IF TG_OP='UPDATE' AND c.finalized_at IS NOT NULL THEN RETURN NEW; END IF;
 END IF;
 SELECT * INTO g FROM recording_device_grants WHERE id=c.grant_id;
 IF c.state='expired' OR c.expires_at<=clock_timestamp() OR g.revoked_at IS NOT NULL
   OR NEW.workspace_id IS DISTINCT FROM g.workspace_id OR actor IS DISTINCT FROM g.owner_id
 THEN RAISE EXCEPTION 'watch_capture_publication_closed'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_watch_capture_publication() FROM PUBLIC;
COMMIT;
