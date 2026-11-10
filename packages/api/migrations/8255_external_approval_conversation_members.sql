BEGIN;
-- Additive: never rewrite a legacy source or its outstanding request hashes.
ALTER TABLE workspace_external_approval_sources
  ALTER COLUMN approver_user_id DROP NOT NULL,
  ADD COLUMN audience text,
  ADD COLUMN destination_session_id uuid,
  ADD COLUMN thread_ref text,
  ADD CONSTRAINT external_approval_source_audience CHECK (
    (audience IS NULL AND destination_session_id IS NULL AND approver_user_id IS NOT NULL AND thread_ref IS NULL)
    OR (audience IS NOT NULL AND audience='conversation_members' AND destination_session_id IS NOT NULL AND approver_user_id IS NULL)),
  ADD CONSTRAINT external_approval_source_thread CHECK (
    thread_ref IS NULL OR (channel_type IN ('slack','feishu') AND length(thread_ref)>0));
-- Ensure old workspaces also have the canonical row used to pin ACL support.
INSERT INTO application_policy_workspace_epochs(workspace_id,revision)
 SELECT id,nextval('application_policy_revision_seq') FROM workspaces
 ON CONFLICT (workspace_id) DO NOTHING;
-- Native approvals still require exactly the same named approver as before.
ALTER TABLE pending_approvals ALTER COLUMN approver_user_id DROP NOT NULL;
ALTER TABLE pending_approvals ADD CONSTRAINT native_approval_requires_approver
  CHECK (approver_user_id IS NOT NULL OR kind IS NOT DISTINCT FROM 'external_action');
CREATE OR REPLACE FUNCTION preserve_external_approval_source_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN
      RAISE EXCEPTION 'Approval sources must be revoked';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.id,NEW.workspace_id,NEW.assistant_id,NEW.approver_user_id,NEW.audience,NEW.destination_session_id,NEW.thread_ref,NEW.channel_type,NEW.channel_id,NEW.channel_integration_id,NEW.name,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.assistant_id,OLD.approver_user_id,OLD.audience,OLD.destination_session_id,OLD.thread_ref,OLD.channel_type,OLD.channel_id,OLD.channel_integration_id,OLD.name,OLD.created_by,OLD.created_at)
    OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Approval source binding is immutable';
  END IF;
  RETURN NEW;
END $$;

-- A narrow boolean facade, never a tenant-readable sidecar/credential projection.
CREATE FUNCTION external_approval_conversation_read_allowed(w uuid,i uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source workspace_external_approval_sources; approval pending_approvals;
 actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 IF actor IS NULL THEN RETURN false; END IF;
 SELECT * INTO approval FROM pending_approvals WHERE id=i AND workspace_id=w AND kind='external_action';
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT src.* INTO source FROM external_approval_requests e
 JOIN workspace_external_approval_sources src ON src.id::text=e.source_id
 WHERE e.approval_id=i AND src.workspace_id=w AND src.assistant_id=approval.originating_assistant_id;
 IF NOT FOUND OR source.revoked_at IS NOT NULL
   OR source.approver_user_id IS DISTINCT FROM approval.approver_user_id
   OR source.channel_type IS DISTINCT FROM approval.delivery_channel_type
   OR source.channel_id IS DISTINCT FROM approval.delivery_channel_id
   OR NOT EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=w AND wm.user_id=actor)
   OR public.assistant_placement_visible(actor,source.assistant_id) IS NOT TRUE THEN RETURN false; END IF;
 IF source.audience IS NULL THEN RETURN source.approver_user_id=actor; END IF;
 RETURN EXISTS (
 SELECT 1 FROM sessions s JOIN assistants a ON a.id=s.assistant_id AND a.workspace_id=s.workspace_id
 CROSS JOIN LATERAL (SELECT CASE
   WHEN s.channel_type='web' THEN s.id::text
   WHEN s.channel_type IN ('slack','feishu') THEN split_part(s.channel_id,':thread:',1)
   ELSE s.channel_id END AS channel_id,
   CASE WHEN s.channel_type IN ('slack','feishu') AND strpos(s.channel_id,':thread:')>0
     THEN substr(s.channel_id,strpos(s.channel_id,':thread:')+8) ELSE NULL END AS thread_ref) provider
 CROSS JOIN LATERAL (SELECT CASE WHEN s.channel_type='telegram'
   AND (provider.channel_id ~ '^(-?[0-9]+):topic:([0-9]+)$' OR provider.channel_id ~ '^(-?[0-9]+):discussion:([1-9][0-9]*)$')
   THEN split_part(provider.channel_id,':',1) ELSE provider.channel_id END AS channel_id) parent
 WHERE s.id=source.destination_session_id AND s.workspace_id=w AND s.assistant_id=source.assistant_id
   AND s.channel_type=source.channel_type AND provider.channel_id=source.channel_id
   AND provider.thread_ref IS NOT DISTINCT FROM source.thread_ref
   AND s.channel_type IN ('web','telegram','slack','whatsapp','feishu','msteams','custom')
   AND s.transient IS NOT TRUE
   AND s.anchor_kind IN ('none','channel') AND s.recording_revision IS NULL
   AND public.session_recording_read_allowed(s.id)
   AND public.workflow_evidence_envelope_visible(s.workspace_id,public.session_context_parent_snapshot(s.workspace_id,s.id))
   AND ((s.channel_type='web' AND source.channel_integration_id IS NULL) OR EXISTS (
     SELECT 1 FROM channel_integrations ci JOIN channels c ON c.id=ci.channel_id
     JOIN channel_assistants ca ON ca.channel_id=ci.channel_id
     WHERE ci.id=source.channel_integration_id AND c.workspace_id=w AND ca.assistant_id=a.id
       AND ci.channel_type=s.channel_type AND ci.status='active' AND c.status='active'
       AND (s.channel_type<>'whatsapp' OR (strpos(provider.channel_id,'@')>0 AND NOT
         (nullif(ci.bot_user_id,'') IS NOT NULL AND nullif(ci.team_id,'') IS NOT NULL)))
       AND ca.id=(SELECT winning.id FROM channel_assistants winning WHERE winning.channel_id=ci.channel_id
         AND (winning.external_surface_id IS NULL OR winning.external_surface_id=provider.channel_id OR winning.external_surface_id=parent.channel_id)
         ORDER BY CASE WHEN winning.external_surface_id=provider.channel_id THEN 0 WHEN winning.external_surface_id=parent.channel_id THEN 1 ELSE 2 END LIMIT 1)
   )));
END $$;
REVOKE ALL ON FUNCTION external_approval_conversation_read_allowed(uuid,uuid) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  GRANT EXECUTE ON FUNCTION external_approval_conversation_read_allowed(uuid,uuid) TO app_user;
 END IF;
END $$;
CREATE POLICY external_approval_conversation_read ON pending_approvals AS RESTRICTIVE FOR SELECT
 USING (kind IS DISTINCT FROM 'external_action' OR public.external_approval_conversation_read_allowed(workspace_id,id));
COMMIT;
