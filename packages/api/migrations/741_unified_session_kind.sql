BEGIN;

-- Unified sessions (docs/plans/unified-sessions.md section 4.5, D6-D10, L10,
-- L12, L17). A session's KIND is stored instead of inferred:
--
--   visibility        the AUDIENCE: 'personal' | 'workspace' ('owner' -> 'personal')
--   anchor_kind/ref   what the conversation is attached to
--   channel_type      narrows to the TRANSPORT ('doc_thread', 'office_thread',
--                     'feed_thread' and 'notification' rows become 'web')
--   clearance_source  where effective_clearance comes from ('assistant' | 'anchor')
--
-- A BEFORE trigger derives the new columns from the legacy discriminators, so
-- a writer that predates them (or a closed-tree writer deployed later) keeps
-- producing correct rows. Runs as an ordinary owner role: triggers are
-- bypassed per table by name, never with session_replication_role.

-- 1. Columns ------------------------------------------------------------------

ALTER TABLE sessions
  ADD COLUMN anchor_kind text NOT NULL DEFAULT 'none',
  ADD COLUMN anchor_ref text,
  ADD COLUMN clearance_source text NOT NULL DEFAULT 'assistant';
ALTER TABLE sessions ADD CONSTRAINT sessions_anchor_kind_check CHECK (anchor_kind IN
  ('none','doc_thread','office_file','feed_draft','feed_thread','channel','inbox','job'));
ALTER TABLE sessions ADD CONSTRAINT sessions_clearance_source_check CHECK (clearance_source IN ('assistant','anchor'));

-- 2. Backfill (no trigger may version, invalidate or journal a rename) --------

ALTER TABLE sessions DISABLE TRIGGER browser_session_scope_version;
ALTER TABLE sessions DISABLE TRIGGER browser_session_scope_descendants;
ALTER TABLE sessions DISABLE TRIGGER crm_recovery_capture;
ALTER TABLE sessions DISABLE TRIGGER department_assistant_sharing;
ALTER TABLE sessions DISABLE TRIGGER sessions_context_binding_valid;
ALTER TABLE sessions DISABLE TRIGGER sessions_context_immutable_after_lock;

ALTER TABLE sessions DROP CONSTRAINT sessions_visibility_check;

UPDATE sessions SET anchor_kind = CASE
    WHEN channel_type = 'doc_thread' THEN 'doc_thread'
    WHEN channel_type = 'office_thread' THEN 'office_file'
    WHEN channel_type = 'feed_thread' THEN 'feed_thread'
    WHEN channel_type = 'notification' OR channel_id = 'notifications' THEN 'inbox'
    WHEN mode = 'draft' THEN 'feed_draft'
    WHEN channel_type IN ('workflow', 'cron') THEN 'job'
    ELSE 'none' END
  WHERE channel_type IN ('doc_thread', 'office_thread', 'feed_thread', 'notification', 'workflow', 'cron')
     OR channel_id = 'notifications' OR mode = 'draft';

UPDATE sessions s SET anchor_ref = ct.id::text FROM comment_threads ct
  WHERE s.anchor_kind = 'doc_thread' AND ct.session_id = s.id;
UPDATE sessions s SET anchor_ref = l.artifact_id::text FROM office_artifact_sessions l
  WHERE s.anchor_kind = 'office_file' AND l.session_id = s.id;
UPDATE sessions s SET anchor_ref = t.id::text FROM feed_comment_threads t
  WHERE s.anchor_kind = 'feed_thread' AND t.transcript_session_id = s.id;
UPDATE sessions SET anchor_ref = id::text WHERE anchor_kind = 'feed_draft';
UPDATE sessions SET anchor_ref = channel_id WHERE anchor_kind = 'job';

-- D6: the audience word.
UPDATE sessions SET visibility = 'personal' WHERE visibility = 'owner';
-- A feed draft is a workspace conversation, whichever writer made it.
UPDATE sessions s SET visibility = 'workspace',
       workspace_id = COALESCE(s.workspace_id, a.workspace_id)
  FROM assistants a WHERE a.id = s.assistant_id AND s.anchor_kind = 'feed_draft';

-- D7: channel_type narrows to the transport. Web-hosted anchors move to 'web'
-- unless a personal web row already holds that identity (a guard, not a case
-- expected in practice).
UPDATE sessions s SET channel_type = 'web'
  WHERE s.channel_type IN ('doc_thread', 'office_thread', 'feed_thread', 'notification')
    AND NOT EXISTS (SELECT 1 FROM sessions o WHERE o.id <> s.id AND o.assistant_id = s.assistant_id
      AND o.user_id = s.user_id AND o.channel_type = 'web' AND o.channel_id = s.channel_id AND o.app_id = s.app_id);

-- D10 / L10 / L17: every workspace row carries a clearance and its source.
UPDATE sessions SET clearance_source = 'anchor'
  WHERE anchor_kind = 'office_file' OR guest_session_token IS NOT NULL;
UPDATE sessions s SET effective_clearance = COALESCE(a.clearance, 'internal')
  FROM assistants a WHERE a.id = s.assistant_id
    AND s.visibility = 'workspace' AND s.effective_clearance IS NULL;
UPDATE sessions SET effective_clearance = 'internal'
  WHERE visibility = 'workspace' AND effective_clearance IS NULL;

ALTER TABLE sessions ALTER COLUMN visibility SET DEFAULT 'personal';
ALTER TABLE sessions ADD CONSTRAINT sessions_visibility_check CHECK (visibility IN ('personal', 'workspace'));
ALTER TABLE sessions ADD CONSTRAINT sessions_workspace_clearance_check
  CHECK (visibility <> 'workspace' OR effective_clearance IS NOT NULL);

ALTER TABLE sessions ENABLE TRIGGER browser_session_scope_version;
ALTER TABLE sessions ENABLE TRIGGER browser_session_scope_descendants;
ALTER TABLE sessions ENABLE TRIGGER crm_recovery_capture;
ALTER TABLE sessions ENABLE TRIGGER department_assistant_sharing;
ALTER TABLE sessions ENABLE TRIGGER sessions_context_binding_valid;
ALTER TABLE sessions ENABLE TRIGGER sessions_context_immutable_after_lock;

-- 3. Derive the kind on every write --------------------------------------------
-- Named aaaa_* so it fires before every other BEFORE trigger (they fire in
-- name order): admission, department and scope triggers see normalized rows.

CREATE FUNCTION derive_session_kind() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.visibility = 'owner' THEN NEW.visibility := 'personal'; END IF;
  IF NEW.anchor_kind = 'none' THEN
    NEW.anchor_kind := CASE
      WHEN NEW.channel_type = 'doc_thread' THEN 'doc_thread'
      WHEN NEW.channel_type = 'office_thread' THEN 'office_file'
      WHEN NEW.channel_type = 'feed_thread' THEN 'feed_thread'
      WHEN NEW.channel_type = 'notification' OR NEW.channel_id = 'notifications' THEN 'inbox'
      WHEN NEW.mode = 'draft' THEN 'feed_draft'
      WHEN NEW.channel_type IN ('workflow', 'cron') THEN 'job'
      ELSE 'none' END;
  END IF;
  IF NEW.channel_type IN ('doc_thread', 'office_thread', 'feed_thread', 'notification') THEN
    NEW.channel_type := 'web';
  END IF;
  IF NEW.anchor_kind = 'feed_draft' THEN
    NEW.visibility := 'workspace';
    IF NEW.anchor_ref IS NULL THEN NEW.anchor_ref := NEW.id::text; END IF;
    IF NEW.workspace_id IS NULL THEN
      SELECT workspace_id INTO NEW.workspace_id FROM assistants WHERE id = NEW.assistant_id;
    END IF;
  END IF;
  IF NEW.anchor_kind = 'job' AND NEW.anchor_ref IS NULL THEN NEW.anchor_ref := NEW.channel_id; END IF;
  IF NEW.anchor_kind = 'office_file' OR NEW.guest_session_token IS NOT NULL THEN
    NEW.clearance_source := 'anchor';
  END IF;
  IF NEW.visibility = 'workspace' AND NEW.effective_clearance IS NULL THEN
    SELECT COALESCE(clearance, 'internal') INTO NEW.effective_clearance FROM assistants WHERE id = NEW.assistant_id;
    NEW.effective_clearance := COALESCE(NEW.effective_clearance, 'internal');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER aaaa_session_kind BEFORE INSERT OR UPDATE OF
  visibility, mode, channel_type, channel_id, anchor_kind, guest_session_token, effective_clearance
  ON sessions FOR EACH ROW EXECUTE FUNCTION derive_session_kind();

-- 4. D8: keys split by audience --------------------------------------------------

ALTER TABLE sessions DROP CONSTRAINT sessions_assistant_id_user_id_channel_type_channel_id_app_i_key;
CREATE UNIQUE INDEX sessions_personal_identity_key
  ON sessions (assistant_id, user_id, channel_type, channel_id, app_id) WHERE visibility = 'personal';
-- A converged group is ONE workspace room per provider conversation, whoever
-- speaks; the assistant is the room's default responder, not part of its key.
CREATE UNIQUE INDEX sessions_channel_room_key
  ON sessions (workspace_id, channel_type, channel_id) WHERE visibility = 'workspace' AND anchor_kind = 'channel';
CREATE INDEX sessions_anchor_idx ON sessions (anchor_kind, anchor_ref) WHERE anchor_kind <> 'none';

-- 5. D9: on a workspace row, user_id means "created by" and grants nothing ------

DROP POLICY sessions_own ON sessions;
CREATE POLICY sessions_own ON sessions
  USING (user_id = (current_setting('app.current_user_id', true))::uuid AND visibility = 'personal');

DROP POLICY session_messages_own ON session_messages;
CREATE POLICY session_messages_own ON session_messages
  USING (EXISTS (SELECT 1 FROM sessions s WHERE s.id = session_messages.session_id
    AND s.user_id = (current_setting('app.current_user_id', true))::uuid AND s.visibility = 'personal'));

-- The message policy states the Team-compartment reach itself rather than
-- relying on the sessions subquery inheriting it.
DROP POLICY session_messages_workspace_shared ON session_messages;
CREATE POLICY session_messages_workspace_shared ON session_messages FOR SELECT
  USING (EXISTS (SELECT 1 FROM sessions s JOIN workspace_members wm ON wm.workspace_id = s.workspace_id
    WHERE s.id = session_messages.session_id AND s.visibility = 'workspace' AND s.workspace_id IS NOT NULL
      AND wm.user_id = (current_setting('app.current_user_id', true))::uuid
      AND sensitivity_rank(s.effective_clearance) <= sensitivity_rank(wm.clearance)
      AND (effective_member_team_compartments(wm.user_id, wm.workspace_id) IS NULL
        OR s.context_compartments <@ effective_member_team_compartments(wm.user_id, wm.workspace_id))));

-- Session state follows the session's audience (unified-sessions §4.6): the
-- row's writer grants nothing on a workspace session, readers of the session
-- read its state. The sessions subquery runs under the sessions policies.
DROP POLICY session_state_own ON session_state;
CREATE POLICY session_state_audience ON session_state
  USING (EXISTS (SELECT 1 FROM sessions s WHERE s.id = session_state.session_id))
  WITH CHECK (EXISTS (SELECT 1 FROM sessions s WHERE s.id = session_state.session_id));

-- 6. Readers of the old discriminators move to the anchor ----------------------

CREATE OR REPLACE FUNCTION public.validate_office_artifact_session()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM office_artifacts a WHERE a.id=NEW.artifact_id AND a.workspace_id=NEW.workspace_id) THEN
    RAISE EXCEPTION 'Office conversation root mismatch' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id=NEW.session_id
      AND s.anchor_kind='office_file' AND s.workspace_id=NEW.workspace_id) THEN
    RAISE EXCEPTION 'Office conversation must be an Office file thread session in the same workspace' USING ERRCODE='23514';
  END IF;
  UPDATE sessions SET anchor_ref = NEW.artifact_id::text WHERE id = NEW.session_id AND anchor_ref IS NULL;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.validate_feed_thread_transcript()
 RETURNS trigger LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sessions WHERE id=NEW.transcript_session_id AND anchor_kind='feed_thread'
    AND workspace_id=NEW.workspace_id AND assistant_id=NEW.assistant_id) THEN
    RAISE EXCEPTION 'Feed transcript scope mismatch' USING ERRCODE='23514';
  END IF;
  UPDATE sessions SET anchor_ref = NEW.id::text WHERE id = NEW.transcript_session_id AND anchor_ref IS NULL;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.delete_feed_thread_transcript()
 RETURNS trigger LANGUAGE plpgsql
AS $function$
BEGIN
  DELETE FROM sessions WHERE id=OLD.transcript_session_id AND anchor_kind='feed_thread';
  RETURN OLD;
END $function$;

CREATE OR REPLACE FUNCTION public.delete_office_artifact_session()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  DELETE FROM sessions WHERE id=OLD.session_id AND anchor_kind='office_file';
  RETURN NULL;
END $function$;

CREATE OR REPLACE FUNCTION public.erase_feed_learning_source()
 RETURNS trigger LANGUAGE plpgsql
AS $function$
DECLARE affected uuid[];
BEGIN
  IF TG_TABLE_NAME='sessions' THEN
    -- Before the session FK cascades destroy the provenance links we traverse.
    IF OLD.anchor_kind='feed_draft' THEN
      PERFORM erase_feed_learning_artifacts(ARRAY[OLD.id]);
    END IF;
    RETURN OLD;
  END IF;
  SELECT coalesce(array_agg(DISTINCT c.session_id),'{}') INTO affected FROM feed_post_confirmations c
    WHERE CASE TG_TABLE_NAME
      WHEN 'session_messages' THEN c.history->'messageIds' ? OLD.id::text
      WHEN 'feed_draft_suggestions' THEN EXISTS(SELECT 1 FROM jsonb_array_elements(c.history->'proposals') p WHERE p->>'id'=OLD.id::text)
      WHEN 'goals' THEN c.history->'goal'->>'id'=OLD.id::text
      WHEN 'workspace_files' THEN c.history->'fileIds' ? OLD.id::text
      WHEN 'decision_events' THEN c.history->'eventIds' ? OLD.id::text
      ELSE false END;
  PERFORM erase_feed_learning_artifacts(affected);
  -- All confirmations in an affected draft can contain the erased history.
  -- Delete the chain together to retain the deferred prior-confirmation FK.
  DELETE FROM feed_post_confirmations WHERE session_id=ANY(affected);
  RETURN OLD;
END $function$;

CREATE OR REPLACE FUNCTION public.validate_feed_collaboration_scope()
 RETURNS trigger LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sessions s JOIN assistants a ON a.id=s.assistant_id
    WHERE s.id=NEW.session_id AND s.workspace_id=NEW.workspace_id AND s.assistant_id=NEW.assistant_id
      AND s.anchor_kind='feed_draft' AND a.workspace_id=NEW.workspace_id
      AND a.kind='app' AND a.app_type='distribution') THEN
    RAISE EXCEPTION 'Feed draft scope mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.read_scope_source_before_workflow_run(w uuid, k text, i uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s sessions; held boolean;
BEGIN
 IF k<>'browser_session' THEN RETURN read_scope_source_before_browser_session(w,k,i); END IF;
 PERFORM id FROM workspaces WHERE id=w FOR SHARE;
 SELECT * INTO s FROM sessions WHERE workspace_id=w AND id=i FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM id FROM assistants WHERE workspace_id=w AND id=s.assistant_id FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 -- Only a personal, unanchored web conversation is a browser-session source.
 held:=s.channel_type IS DISTINCT FROM 'web' OR s.visibility IS DISTINCT FROM 'personal' OR s.anchor_kind<>'none'
  OR s.context_locked_at IS NULL OR s.context_binding_origin='held' OR s.context_compartments IS NULL
  OR (s.context_group_id IS NOT NULL AND NOT ('team:'||s.context_group_id::text)=ANY(s.context_compartments))
  OR EXISTS(SELECT 1 FROM unnest(s.context_compartments) label WHERE label IS NULL OR NOT EXISTS(
   SELECT 1 FROM workspace_groups g WHERE g.workspace_id=w AND g.kind='team' AND g.compartment_key=label))
  OR (s.context_project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workspace_projects p
   WHERE p.workspace_id=w AND p.id=s.context_project_id));
 RETURN jsonb_build_object('workspaceId',w,'resourceKind',k,'resourceId',i,'version',s.browser_source_version::text,
  'userId',s.user_id,'assistantId',NULL,'sensitivity',coalesce(s.effective_clearance,'public'),
  'compartments',to_jsonb(s.context_compartments),'projectIds',CASE WHEN s.context_project_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(s.context_project_id) END,
  'held',held,'validTo',NULL,'retractedAt',NULL);
END $function$;

-- The anchor is part of a browser-session source's scope identity.
CREATE OR REPLACE FUNCTION public.browser_session_scope_fields(s jsonb)
 RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT jsonb_build_array(s->'workspace_id',s->'assistant_id',s->'user_id',s->'channel_type',s->'visibility',s->'mode',
  s->'context_group_id',s->'context_project_id',s->'context_locked_at',s->'context_binding_origin',s->'effective_clearance',s->'context_compartments',
  s->'anchor_kind')
$function$;

-- 7. 663: a department assistant's ROOM binds the department compartment ------

CREATE OR REPLACE FUNCTION public.guard_department_assistant_sharing()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE ids uuid[];
BEGIN
  IF TG_TABLE_NAME='assistant_connections' THEN
    ids:=ARRAY[NEW.follower_assistant_id,NEW.following_assistant_id];
  ELSE
    ids:=ARRAY[NEW.assistant_id];
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.assistants WHERE id=ANY(ids) AND placement_department_id IS NOT NULL) THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='api_keys' THEN
    IF NEW.audience='internal' AND public.assistant_placement_visible(NEW.created_by,NEW.assistant_id) THEN RETURN NEW; END IF;
  END IF;
  IF TG_TABLE_NAME='sessions' THEN
    IF NEW.visibility='personal' AND public.assistant_placement_visible(NEW.user_id,NEW.assistant_id) THEN RETURN NEW; END IF;
    -- A workspace audience is admitted only when the conversation is bound to
    -- the assistant's department compartment, so the department is its reach.
    IF NEW.visibility='workspace' AND EXISTS(SELECT 1 FROM public.assistants a
        JOIN public.workspace_groups g ON g.id=a.placement_department_id
       WHERE a.id=NEW.assistant_id AND g.compartment_key IS NOT NULL
         AND g.compartment_key=ANY(NEW.context_compartments)) THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'department_assistant_requires_private_access';
END $function$;

-- 8. L12: creation admission knows anchored threads and channel rooms ----------

CREATE OR REPLACE FUNCTION public.require_personal_web_session_admission()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE p public.workspace_access_policies; r jsonb; aw uuid;
BEGIN
 IF NEW.visibility<>'personal' OR NEW.anchor_kind<>'none' OR NEW.mode IS NOT NULL OR NEW.channel_type<>'web' OR NEW.app_origin IS DISTINCT FROM 'chat' THEN RETURN NEW; END IF;
 SELECT workspace_id INTO aw FROM public.assistants WHERE id=NEW.assistant_id;
 PERFORM id FROM public.workspaces WHERE id IN (aw,NEW.workspace_id) ORDER BY id FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM public.workspace_access_policies WHERE workspace_id IN(aw,NEW.workspace_id) AND setup_state<>'legacy') THEN RETURN NEW; END IF;
 PERFORM 1 FROM public.assistants WHERE id=NEW.assistant_id AND workspace_id=NEW.workspace_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'personal_session_locality_required' USING ERRCODE='42501'; END IF;
 SELECT * INTO p FROM public.workspace_access_policies WHERE workspace_id=NEW.workspace_id;
 BEGIN
  r:=nullif(current_setting('app.session_creation_admission',true),'')::jsonb;
 EXCEPTION WHEN invalid_text_representation THEN
  RAISE EXCEPTION 'personal_session_admission_required' USING ERRCODE='42501';
 END;
 PERFORM set_config('app.session_creation_admission','',true);
 IF r IS NULL OR r->>'protocol' IS DISTINCT FROM '1'
 OR r->>'provenance' IS DISTINCT FROM 'authenticated_personal_web'
 OR r->>'actorUserId' IS DISTINCT FROM NEW.user_id::text
 OR nullif(current_setting('app.current_user_id',true),'') IS DISTINCT FROM NEW.user_id::text
 OR r->>'workspaceId' IS DISTINCT FROM NEW.workspace_id::text
 OR r->>'policyRevision' IS DISTINCT FROM p.revision::text
 OR r->>'assistantId' IS DISTINCT FROM NEW.assistant_id::text
 OR r->>'userId' IS DISTINCT FROM NEW.user_id::text
 OR r->>'channelId' IS DISTINCT FROM NEW.channel_id
 OR r->>'appId' IS DISTINCT FROM NEW.app_id
 OR r->>'contextGroupId' IS DISTINCT FROM NEW.context_group_id::text
 OR r->>'contextProjectId' IS DISTINCT FROM NEW.context_project_id::text
 OR r->'compartments' IS DISTINCT FROM to_jsonb(NEW.context_compartments)
 OR NEW.effective_clearance IS NOT NULL
 THEN RAISE EXCEPTION 'personal_session_admission_required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.auth_sessions s JOIN public.users u ON u.id=s.user_id
 JOIN public.workspace_members m ON m.user_id=u.id AND m.workspace_id=NEW.workspace_id
 WHERE s.id::text=r->>'authSessionId' AND u.id=NEW.user_id
 AND s.auth_version::text=r->>'authVersion' AND u.auth_version=s.auth_version
 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF s,u,m;
 IF NOT FOUND THEN RAISE EXCEPTION 'personal_session_principal_unavailable' USING ERRCODE='42501'; END IF;
 IF public.personal_web_session_scope_allows(NEW.workspace_id,NEW.user_id,NEW.assistant_id,
   NEW.context_group_id,NEW.context_project_id,NEW.context_compartments) IS NOT TRUE THEN
  RAISE EXCEPTION 'personal_session_scope_unavailable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.require_session_creation_admission()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE assistant_workspace uuid; current_workspace uuid;
  policy public.workspace_access_policies; receipt jsonb; actor uuid; provenance text;
BEGIN
  IF NEW.visibility IS DISTINCT FROM 'workspace' THEN RETURN NEW; END IF;
  SELECT workspace_id INTO assistant_workspace FROM public.assistants WHERE id=NEW.assistant_id;
  -- Lock both addresses, checking actual output workspace, never just assistant policy.
  PERFORM id FROM public.workspaces WHERE id IN (NEW.workspace_id,assistant_workspace) ORDER BY id FOR UPDATE;
  SELECT workspace_id INTO current_workspace FROM public.assistants WHERE id=NEW.assistant_id FOR SHARE;
  IF current_workspace IS DISTINCT FROM assistant_workspace THEN
    RAISE EXCEPTION 'access_policy_conflict' USING ERRCODE='40001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_access_policies
    WHERE workspace_id IN (NEW.workspace_id,assistant_workspace) AND setup_state<>'legacy') THEN
    -- Receipt-free legacy compatibility is not ready-mode admission.
    IF nullif(current_setting('app.session_creation_admission',true),'') IS NOT NULL THEN
      RAISE EXCEPTION 'workspace_creation_policy_not_ready' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.workspace_id IS NULL OR assistant_workspace IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION 'workspace_creation_admission_required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO policy FROM public.workspace_access_policies WHERE workspace_id=NEW.workspace_id;
  BEGIN
    receipt:=nullif(current_setting('app.session_creation_admission',true),'')::jsonb;
    actor:=(receipt->>'actor')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'workspace_creation_admission_required' USING ERRCODE='42501';
  END;
  PERFORM set_config('app.session_creation_admission','',true);
  provenance:=receipt->>'provenance';
  IF receipt IS NULL OR receipt->>'protocol' IS DISTINCT FROM '1'
    OR receipt->>'workspaceId' IS DISTINCT FROM NEW.workspace_id::text
    OR receipt->>'policyRevision' IS DISTINCT FROM policy.revision::text
    OR receipt->>'assistantId' IS DISTINCT FROM NEW.assistant_id::text
    OR receipt->>'userId' IS DISTINCT FROM NEW.user_id::text
    OR receipt->>'anchorKind' IS DISTINCT FROM NEW.anchor_kind
    OR receipt->>'sensitivity' IS DISTINCT FROM NEW.effective_clearance
  THEN RAISE EXCEPTION 'workspace_creation_admission_required' USING ERRCODE='42501'; END IF;

  IF provenance = 'authenticated_chat_root' THEN
    -- The Chat app's room: an authenticated member's explicit destination choice.
    IF actor IS DISTINCT FROM NEW.user_id
      OR NOT EXISTS(SELECT 1 FROM public.workspace_members WHERE workspace_id=NEW.workspace_id AND user_id=actor)
      OR (nullif(current_setting('app.current_user_id',true),'') IS NOT NULL
        AND nullif(current_setting('app.current_user_id',true),'')::uuid IS DISTINCT FROM actor)
      OR NEW.anchor_kind <> 'none' OR NEW.mode IS NOT NULL
      OR NEW.channel_type IS DISTINCT FROM 'web' OR NEW.app_origin IS DISTINCT FROM 'chat'
      OR receipt->>'channelType' IS DISTINCT FROM NEW.channel_type
      OR receipt->>'channelId' IS DISTINCT FROM NEW.channel_id
      OR receipt->>'appId' IS DISTINCT FROM NEW.app_id
      OR receipt->>'appOrigin' IS DISTINCT FROM NEW.app_origin
      OR receipt->>'groupId' IS DISTINCT FROM NEW.context_group_id::text
      OR receipt->>'projectId' IS DISTINCT FROM NEW.context_project_id::text
      OR receipt->'compartments' IS DISTINCT FROM to_jsonb(NEW.context_compartments)
    THEN RAISE EXCEPTION 'workspace_creation_admission_required' USING ERRCODE='42501'; END IF;
    -- A matched receipt/row pair is not a grant. Resolve live member and
    -- assistant caps with the same predicate as personal creation, then apply
    -- shared-only placement and sensitivity rules. Do not default a row here.
    IF policy.setup_state IS DISTINCT FROM 'ready'
      OR (policy.access_mode='simple' AND (policy.default_department_id IS NULL
        OR NEW.context_group_id IS DISTINCT FROM policy.default_department_id))
      OR NEW.effective_clearance IS DISTINCT FROM (SELECT clearance FROM public.assistants WHERE id=NEW.assistant_id)
      OR public.personal_web_session_scope_allows(NEW.workspace_id,actor,NEW.assistant_id,
        NEW.context_group_id,NEW.context_project_id,NEW.context_compartments) IS NOT TRUE
    THEN RAISE EXCEPTION 'workspace_creation_scope_unavailable' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;

  IF provenance = 'anchored_thread' THEN
    -- A doc / Office / feed thread or a feed draft: the anchor decides its
    -- audience, the app checked the actor's authority over the anchor before
    -- minting this receipt. The row must name a member (or, for a guest doc
    -- thread on a public page, the guest sentinel) and its anchor.
    IF NEW.anchor_kind NOT IN ('doc_thread','office_file','feed_draft','feed_thread')
      OR (receipt ? 'anchorRef' AND receipt->>'anchorRef' IS DISTINCT FROM NEW.anchor_ref)
      OR (actor IS DISTINCT FROM NEW.user_id)
      OR (NOT EXISTS(SELECT 1 FROM public.workspace_members WHERE workspace_id=NEW.workspace_id AND user_id=actor)
        AND NOT (NEW.anchor_kind='doc_thread' AND receipt->>'guest'='true' AND NEW.effective_clearance='public'))
    THEN RAISE EXCEPTION 'workspace_creation_admission_required' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;

  IF provenance = 'channel_room' THEN
    -- A converged provider group (D15): the workspace that bound the group's
    -- channel integration owns the room.
    IF NEW.anchor_kind <> 'channel'
      OR receipt->>'channelType' IS DISTINCT FROM NEW.channel_type
      OR receipt->>'channelId' IS DISTINCT FROM NEW.channel_id
      OR NOT EXISTS(SELECT 1 FROM public.channel_integrations ci JOIN public.channels c ON c.id=ci.channel_id
        WHERE ci.id::text=receipt->>'channelIntegrationId' AND c.workspace_id=NEW.workspace_id
          AND ci.channel_type=NEW.channel_type)
    THEN RAISE EXCEPTION 'workspace_creation_admission_required' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'workspace_creation_admission_required' USING ERRCODE='42501';
END $function$;

COMMIT;
