BEGIN;

-- Content-free, source-owned feedback recovery intent. See features/research.md.
-- [COMP:api/research-feedback-replay]
CREATE TABLE public.research_feedback_attempts (
  message_id uuid PRIMARY KEY REFERENCES public.session_messages(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  assistant_id uuid NOT NULL REFERENCES public.assistants(id) ON DELETE CASCADE,
  message_version bigint NOT NULL CHECK(message_version>0),
  context_key text NOT NULL CHECK(context_key ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK(state IN ('pending','evaluated','complete','blocked')),
  reason text CHECK(reason IN ('no_member_text','no_research','multiple_outputs','unrelated_or_uncertain','source_unavailable','context_changed')),
  association text CHECK(association IN ('explicit_selection','explicit_reply','same_chat_continuation')),
  -- Opaque source-owned references intentionally survive target removal.
  -- A missing target must not erase an intent and silently rebind its source.
  target_activity_id uuid,
  target_output_key text CHECK(length(target_output_key) BETWEEN 1 AND 200),
  selected_activity_id uuid,
  reply_to_message_id uuid,
  attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  last_attempt_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((lease_token IS NULL)=(lease_until IS NULL)),
  CHECK(state='pending' OR lease_token IS NULL),
  CHECK((state IN ('evaluated','blocked'))=(reason IS NOT NULL)),
  CHECK(state='evaluated' OR (state='blocked' AND association='explicit_selection' AND target_activity_id IS NOT NULL
    AND selected_activity_id=target_activity_id AND target_output_key IS NULL)
    OR (association IS NOT NULL AND target_activity_id IS NOT NULL AND target_output_key IS NOT NULL))
);
CREATE INDEX research_feedback_attempts_pending ON public.research_feedback_attempts
  (workspace_id,session_id,actor_user_id,last_attempt_at NULLS FIRST,created_at,message_id) WHERE state='pending';

-- Historical feedback stays byte-identical. Metadata completes the receipt
-- anti-join even when a currently hidden target removes its viewer projection.
INSERT INTO public.research_feedback_attempts
  (message_id,workspace_id,session_id,actor_user_id,assistant_id,message_version,context_key,state,
   association,target_activity_id,target_output_key,created_at,updated_at)
SELECT f.message_id,f.workspace_id,m.session_id,f.actor_user_id,s.assistant_id,f.message_version,repeat('0',64),'complete',
  f.association,f.activity_id,f.output_key,f.created_at,f.updated_at
FROM public.research_feedback f JOIN public.session_messages m ON m.id=f.message_id JOIN public.sessions s ON s.id=m.session_id;

ALTER TABLE public.research_feedback_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY research_feedback_attempt_metadata_read ON public.research_feedback_attempts FOR SELECT USING (
  actor_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
  AND EXISTS(SELECT 1 FROM public.session_messages m JOIN public.sessions s ON s.id=m.session_id
    JOIN public.workspace_members wm ON wm.workspace_id=s.workspace_id
    WHERE m.id=research_feedback_attempts.message_id AND m.session_id=research_feedback_attempts.session_id
      AND s.workspace_id=research_feedback_attempts.workspace_id AND wm.user_id=research_feedback_attempts.actor_user_id
      AND m.role='user' AND coalesce(m.scope_held,false)=false)
);
-- Both fresh fixtures and production may have broad default table privileges.
-- Revoke those explicitly; the anti-join needs only these seven columns.
REVOKE ALL ON public.research_feedback_attempts FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
    REVOKE ALL ON public.research_feedback_attempts FROM app_user;
    GRANT SELECT(message_id,workspace_id,session_id,actor_user_id,message_version,context_key,state)
      ON public.research_feedback_attempts TO app_user;
  END IF;
END $$;

COMMIT;
