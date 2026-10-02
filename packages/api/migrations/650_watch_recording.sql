-- Owner-pool only: the dedicated device API performs authorization on every request.
BEGIN;
CREATE TABLE recording_device_grants (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 device_id uuid NOT NULL, workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
 deployment text NOT NULL, label text NOT NULL,
 access_hash text NOT NULL UNIQUE, access_expires_at timestamptz NOT NULL,
 revoked_at timestamptz, expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON recording_device_grants(owner_id,workspace_id);
CREATE UNIQUE INDEX recording_device_provisioning_identity ON recording_device_grants(owner_id,device_id,workspace_id,deployment) WHERE revoked_at IS NULL;
CREATE TABLE recording_device_renewals (
 hash text PRIMARY KEY, grant_id uuid NOT NULL REFERENCES recording_device_grants(id) ON DELETE CASCADE,
 used_at timestamptz
);
CREATE TABLE watch_captures (
 id uuid PRIMARY KEY, grant_id uuid NOT NULL REFERENCES recording_device_grants(id) ON DELETE CASCADE,
 client_id uuid NOT NULL, metadata jsonb NOT NULL,
 page_id uuid NOT NULL UNIQUE, recording_id uuid NOT NULL UNIQUE,
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','sealed','finalized','expired')),
 finalization jsonb, finalized_at timestamptz, page_prepared boolean NOT NULL DEFAULT false, page_prepare_started boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
 UNIQUE(grant_id,client_id)
);
CREATE INDEX ON watch_captures(expires_at);
CREATE INDEX ON recording_device_renewals(grant_id);
CREATE TABLE watch_capture_windows (
 capture_id uuid NOT NULL REFERENCES watch_captures(id) ON DELETE CASCADE,
 sequence integer NOT NULL CHECK(sequence BETWEEN 0 AND 1079),
 chunk_id uuid NOT NULL UNIQUE, offset_ms integer NOT NULL CHECK(offset_ms>=0),
 duration_ms integer NOT NULL CHECK(duration_ms BETWEEN 1 AND 60000),
 checksum text NOT NULL CHECK(checksum ~ '^[a-f0-9]{64}$'),
 audio bytea, bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 2097152),
 transcript jsonb, attempts integer NOT NULL DEFAULT 0,
 PRIMARY KEY(capture_id,sequence), CHECK(offset_ms+duration_ms<=10800000)
);
CREATE TABLE watch_capture_uploads (
 capture_id uuid PRIMARY KEY REFERENCES watch_captures(id) ON DELETE CASCADE,
 checksum text NOT NULL CHECK(checksum ~ '^[a-f0-9]{64}$'),
 bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 67108864),
 duration_ms integer NOT NULL CHECK(duration_ms BETWEEN 1 AND 10800000),
 audio bytea, CHECK(audio IS NULL OR octet_length(audio)=bytes)
);
ALTER TABLE watch_capture_uploads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON watch_capture_uploads FROM PUBLIC;
ALTER TABLE recording_device_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE recording_device_renewals ENABLE ROW LEVEL SECURITY;
ALTER TABLE watch_captures ENABLE ROW LEVEL SECURITY;
ALTER TABLE watch_capture_windows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON recording_device_grants,recording_device_renewals,watch_captures,watch_capture_windows FROM PUBLIC;
-- Canonical publish_file_recording currently uses now() for occurred_at and has
-- no timestamp parameter. Stamp BEFORE INSERT, before its scope lineage is read:
-- never mutate the immutable Episode/provenance after publication. Non-watch
-- recordings are untouched. Only the frozen owner/destination can use a reserved ID.
CREATE FUNCTION stamp_watch_capture_occurred_at() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c watch_captures; g recording_device_grants;
BEGIN
 SELECT * INTO c FROM watch_captures WHERE recording_id=NEW.id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 SELECT * INTO g FROM recording_device_grants WHERE id=c.grant_id;
 IF c.state <> 'sealed' OR c.expires_at<=clock_timestamp() OR g.revoked_at IS NOT NULL
   OR NEW.workspace_id IS DISTINCT FROM g.workspace_id
   -- Canonical human-uploaded root media has no assistant partition.
   OR NEW.assistant_id IS NOT NULL
   OR NEW.created_by_user_id IS DISTINCT FROM g.owner_id
   OR nullif(current_setting('app.current_user_id',true),'')::uuid IS DISTINCT FROM g.owner_id
   OR nullif(current_setting('app.media_intake_parent',true),'') IS NULL
 THEN RAISE EXCEPTION 'watch_recording_provenance_mismatch'; END IF;
 NEW.occurred_at := (c.metadata->>'capturedAt')::timestamptz;
 RETURN NEW;
END $$;
CREATE TRIGGER watch_capture_occurred_at BEFORE INSERT ON episodes
 FOR EACH ROW WHEN (NEW.source_kind='recording') EXECUTE FUNCTION stamp_watch_capture_occurred_at();
REVOKE ALL ON FUNCTION stamp_watch_capture_occurred_at() FROM PUBLIC;
-- Guard the narrow watch-owned publication destinations at their SQL boundary,
-- not only before asynchronous storage/doc calls. Existing web destinations are unchanged.
CREATE FUNCTION guard_watch_capture_publication() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c watch_captures; g recording_device_grants; actor uuid;
BEGIN
 IF TG_TABLE_NAME='workspace_files' THEN
  SELECT * INTO c FROM watch_captures WHERE id=substring(NEW.path FROM '^/recordings/watch/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[.]m4a$')::uuid;
  IF NOT FOUND THEN RETURN NEW; END IF;
  actor:=NEW.created_by_user_id;
  IF c.state<>'sealed' THEN RAISE EXCEPTION 'watch_capture_publication_closed'; END IF;
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
CREATE TRIGGER watch_media_publication_guard BEFORE INSERT ON workspace_files
 FOR EACH ROW WHEN (NEW.path LIKE '/recordings/watch/%') EXECUTE FUNCTION guard_watch_capture_publication();
CREATE TRIGGER watch_page_creation_guard BEFORE INSERT ON saved_views
 FOR EACH ROW EXECUTE FUNCTION guard_watch_capture_publication();
CREATE TRIGGER watch_page_link_guard BEFORE UPDATE OF linked_recording_id ON saved_views
 FOR EACH ROW WHEN (NEW.linked_recording_id IS DISTINCT FROM OLD.linked_recording_id)
 EXECUTE FUNCTION guard_watch_capture_publication();
REVOKE ALL ON FUNCTION guard_watch_capture_publication() FROM PUBLIC;
COMMIT;
