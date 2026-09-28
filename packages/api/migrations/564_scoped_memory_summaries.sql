-- Scoped derived summaries reuse canonical memory visibility and lineage.
BEGIN;
CREATE TABLE memory_summary_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('soul','domain')),
  slot_key text NOT NULL CHECK (length(slot_key) BETWEEN 1 AND 1024),
  scope_key text NOT NULL CHECK (length(scope_key) > 0),
  memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,owner_user_id,owner_assistant_id,kind,slot_key,scope_key)
);
CREATE INDEX memory_summary_slots_memory_idx ON memory_summary_slots(memory_id);
CREATE FUNCTION validate_memory_summary_slot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memories WHERE id=NEW.memory_id AND workspace_id=NEW.workspace_id)
    OR NOT EXISTS(SELECT 1 FROM assistants WHERE id=NEW.owner_assistant_id AND workspace_id=NEW.workspace_id)
    OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE user_id=NEW.owner_user_id AND workspace_id=NEW.workspace_id) THEN
    RAISE EXCEPTION 'summary references must remain within the workspace';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER memory_summary_slots_references BEFORE INSERT OR UPDATE ON memory_summary_slots
  FOR EACH ROW EXECUTE FUNCTION validate_memory_summary_slot();
ALTER TABLE memory_summary_slots ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_summary_slots_admin ON memory_summary_slots FOR SELECT USING (
  workspace_id IN (SELECT workspace_id FROM workspace_members
    WHERE user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND role IN ('owner','admin'))
);
CREATE POLICY memory_summary_slots_system ON memory_summary_slots FOR ALL
  USING (current_setting('app.system_bypass',true)='true') WITH CHECK (current_setting('app.system_bypass',true)='true');
COMMIT;
