BEGIN;

-- Internal transport coordination, not a user-readable content store.
CREATE TABLE channel_media_receipts (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_type TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'claimed' CHECK (state IN ('claimed','complete','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, channel_type, conversation_id, operation_key)
);

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
    -- A channel room is classified by its group approval, independently of
    -- the first bot's placement. The channel_room admission receipt still
    -- verifies the workspace/integration; each turn checks the bot's grants.
    IF NEW.visibility='workspace' AND NEW.anchor_kind='channel' THEN RETURN NEW; END IF;
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

COMMIT;
