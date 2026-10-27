-- [COMP:api/channel-recording] Attribution is never inferred for existing installations.
BEGIN;
ALTER TABLE channel_integrations ADD COLUMN recording_owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE TABLE channel_recording_policies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 integration_id uuid REFERENCES channel_integrations(id) ON DELETE SET NULL,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 bot_id text NOT NULL,
 owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 conversation_id text NOT NULL,
 enabled boolean NOT NULL DEFAULT true,
 destination text NOT NULL DEFAULT 'personal' CHECK(destination IN ('personal','workspace')),
 project_id uuid REFERENCES workspace_projects(id),
 revision integer NOT NULL DEFAULT 1,
 session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,bot_id,conversation_id),
 UNIQUE(integration_id,conversation_id),
 CHECK(destination='workspace' OR project_id IS NULL)
);
ALTER TABLE sessions ADD COLUMN recording_policy_id uuid REFERENCES channel_recording_policies(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN recording_revision integer;
DROP INDEX sessions_channel_room_key;
CREATE UNIQUE INDEX sessions_channel_room_key ON sessions(workspace_id,channel_type,channel_id)
 WHERE visibility='workspace' AND anchor_kind='channel' AND recording_revision IS NULL;
CREATE UNIQUE INDEX sessions_recording_epoch_key ON sessions(recording_policy_id,recording_revision)
 WHERE recording_policy_id IS NOT NULL;
CREATE TABLE channel_recording_messages (
 policy_id uuid NOT NULL REFERENCES channel_recording_policies(id) ON DELETE CASCADE,
 provider_message_id text NOT NULL,
 session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
 PRIMARY KEY(policy_id,provider_message_id)
);
-- A Personal provider anchor is neither an authenticated web root nor a
-- generic shared channel room. Require its own exact one-use provenance.
CREATE FUNCTION admit_channel_recording_session() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p channel_recording_policies; receipt jsonb; owner_id uuid; w uuid;
BEGIN
 IF NEW.recording_revision IS NULL AND NEW.recording_policy_id IS NULL THEN RETURN NEW; END IF;
 receipt:=nullif(current_setting('app.recording_session_admission',true),'')::jsonb;
 PERFORM set_config('app.recording_session_admission','',true);
 SELECT * INTO p FROM channel_recording_policies WHERE id=NEW.recording_policy_id FOR SHARE;
 SELECT ci.recording_owner_user_id,c.workspace_id INTO owner_id,w FROM channel_integrations ci
 JOIN channels c ON c.id=ci.channel_id JOIN workspace_members wm ON wm.workspace_id=c.workspace_id AND wm.user_id=ci.recording_owner_user_id
 WHERE ci.id=p.integration_id AND ci.status='active' AND c.status='active' AND ci.channel_type='telegram';
 IF receipt IS NULL OR p.id IS NULL OR NOT p.enabled OR owner_id IS NULL
 OR p.owner_user_id IS DISTINCT FROM owner_id OR NEW.user_id IS DISTINCT FROM owner_id OR NEW.workspace_id IS DISTINCT FROM w
 OR NOT EXISTS(SELECT 1 FROM assistants WHERE id=NEW.assistant_id AND workspace_id=w)
 OR NEW.visibility IS DISTINCT FROM p.destination OR NEW.recording_revision IS DISTINCT FROM p.revision
 OR NEW.channel_type<>'telegram' OR NEW.channel_id IS DISTINCT FROM p.conversation_id OR NEW.anchor_kind<>'channel'
 OR receipt->>'sessionId' IS DISTINCT FROM NEW.id::text OR receipt->>'policyId' IS DISTINCT FROM p.id::text
 OR receipt->>'ownerId' IS DISTINCT FROM owner_id::text OR receipt->>'assistantId' IS DISTINCT FROM NEW.assistant_id::text
 OR receipt->>'workspaceId' IS DISTINCT FROM w::text OR receipt->>'destination' IS DISTINCT FROM p.destination
 OR receipt->>'revision' IS DISTINCT FROM p.revision::text
 OR receipt->>'effectiveClearance' IS DISTINCT FROM NEW.effective_clearance
 OR receipt->>'contextGroupId' IS DISTINCT FROM NEW.context_group_id::text
 OR receipt->>'contextProjectId' IS DISTINCT FROM NEW.context_project_id::text
 OR receipt->'contextCompartments' IS DISTINCT FROM to_jsonb(NEW.context_compartments)
 THEN RAISE EXCEPTION 'recording_admission_required' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER channel_recording_session_admission BEFORE INSERT ON sessions
 FOR EACH ROW EXECUTE FUNCTION admit_channel_recording_session();
-- A generic session update cannot publish private history or move an epoch.
CREATE FUNCTION guard_channel_recording_session_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.recording_revision IS NULL AND NEW.recording_revision IS NULL
 AND OLD.recording_policy_id IS NULL AND NEW.recording_policy_id IS NULL THEN RETURN NEW; END IF;
 IF ROW(NEW.recording_revision,NEW.workspace_id,NEW.user_id,NEW.assistant_id,NEW.visibility,
   NEW.channel_type,NEW.channel_id,NEW.anchor_kind,NEW.anchor_ref,NEW.context_group_id,
   NEW.context_project_id,NEW.context_compartments,NEW.effective_clearance)
 IS DISTINCT FROM ROW(OLD.recording_revision,OLD.workspace_id,OLD.user_id,OLD.assistant_id,OLD.visibility,
   OLD.channel_type,OLD.channel_id,OLD.anchor_kind,OLD.anchor_ref,OLD.context_group_id,
   OLD.context_project_id,OLD.context_compartments,OLD.effective_clearance)
 OR NEW.room_capture
 OR (NEW.recording_policy_id IS DISTINCT FROM OLD.recording_policy_id AND
   (NEW.recording_policy_id IS NOT NULL OR EXISTS(SELECT 1 FROM channel_recording_policies WHERE id=OLD.recording_policy_id)))
 THEN RAISE EXCEPTION 'recording_epoch_immutable' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER channel_recording_session_update BEFORE UPDATE ON sessions
 FOR EACH ROW EXECUTE FUNCTION guard_channel_recording_session_update();
-- Keep a non-content replay tombstone after transcript deletion. Deletion
-- cannot cause Telegram retries to resurrect or publish the old message.
CREATE FUNCTION guard_channel_recording_message() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p channel_recording_policies; s sessions; owner_id uuid;
BEGIN
 SELECT * INTO s FROM sessions WHERE id=NEW.session_id;
 IF s.recording_revision IS NULL THEN RETURN NEW; END IF;
 PERFORM id FROM workspaces WHERE id=s.workspace_id FOR UPDATE;
 SELECT * INTO p FROM channel_recording_policies WHERE id=s.recording_policy_id FOR SHARE;
 SELECT ci.recording_owner_user_id INTO owner_id FROM channel_integrations ci
 JOIN channels c ON c.id=ci.channel_id JOIN workspace_members wm
 ON wm.workspace_id=c.workspace_id AND wm.user_id=ci.recording_owner_user_id
 WHERE ci.id=p.integration_id AND ci.status='active' AND c.status='active' AND c.workspace_id=s.workspace_id FOR SHARE OF ci,c,wm;
 IF p.id IS NULL OR NOT p.enabled OR owner_id IS NULL OR p.owner_user_id IS DISTINCT FROM owner_id OR p.session_id IS DISTINCT FROM s.id
 OR p.revision IS DISTINCT FROM s.recording_revision
 OR s.visibility IS DISTINCT FROM p.destination
 OR (p.destination='workspace' AND s.context_project_id IS DISTINCT FROM p.project_id)
 OR (s.visibility='personal' AND s.user_id IS DISTINCT FROM owner_id)
 THEN RAISE EXCEPTION 'recording_destination_unavailable' USING ERRCODE='42501'; END IF;
 IF p.destination='workspace' AND p.project_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM workspace_projects pr JOIN project_shared_scopes ps ON ps.project_id=pr.id JOIN workspaces w ON w.id=pr.workspace_id
 WHERE pr.id=p.project_id AND pr.workspace_id=s.workspace_id AND pr.status='active' AND ps.status='active'
 AND w.project_shared_spaces AND w.department_read_v2
 AND project_member_live(pr.id,'user',owner_id) AND project_member_live(pr.id,'assistant',s.assistant_id))
 THEN RAISE EXCEPTION 'recording_destination_unavailable' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER channel_recording_message_guard BEFORE INSERT ON session_messages
 FOR EACH ROW EXECUTE FUNCTION guard_channel_recording_message();
-- Policy rows are owner-only; service webhook code rechecks live ownership.
ALTER TABLE channel_recording_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY recording_owner ON channel_recording_policies USING (
 EXISTS(SELECT 1 FROM channel_integrations ci JOIN channels c ON c.id=ci.channel_id
 JOIN workspace_members wm ON wm.workspace_id=c.workspace_id AND wm.user_id=ci.recording_owner_user_id
 WHERE ci.id=integration_id AND ci.recording_owner_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid)
);
ALTER TABLE channel_recording_messages ENABLE ROW LEVEL SECURITY;
COMMIT;
