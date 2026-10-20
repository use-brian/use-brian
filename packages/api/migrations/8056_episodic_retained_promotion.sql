BEGIN;

-- Retire promoted episodes without erasing the certified source of the memory.
-- No FK: deleting the destination must never reset retirement and resurrect it.
ALTER TABLE episodic_memories ADD COLUMN promoted_memory_id uuid;
CREATE UNIQUE INDEX episodic_promoted_memory_once ON episodic_memories(promoted_memory_id)
 WHERE promoted_memory_id IS NOT NULL;
CREATE FUNCTION guard_episodic_promotion() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.promoted_memory_id IS NOT NULL THEN
  IF NEW.promoted_memory_id IS DISTINCT FROM OLD.promoted_memory_id THEN
   RAISE EXCEPTION 'episodic_promotion_immutable';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.promoted_memory_id IS NULL THEN RETURN NEW; END IF;
 IF NEW.scope_revision_id IS NULL OR NOT EXISTS(
  SELECT 1 FROM session_context_scope_revisions r
   JOIN memories m ON m.workspace_id=r.workspace_id AND m.id=NEW.promoted_memory_id
   JOIN scope_derivations d ON d.workspace_id=m.workspace_id AND d.resource_kind='memory'
    AND d.resource_id=m.id AND d.resource_version=m.scope_version::text
   JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
    AND s.source_kind='session_context_revision' AND s.source_id=r.id AND s.source_version=r.scope_version::text
   WHERE r.id=NEW.scope_revision_id AND r.parent_kind='episodic_memory'
    AND r.parent_id=NEW.id AND r.session_id=NEW.session_id AND m.valid_to IS NULL
 ) THEN RAISE EXCEPTION 'episodic_promotion_requires_derivation'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_episodic_promotion() FROM PUBLIC;
CREATE TRIGGER episodic_promotion_integrity BEFORE INSERT OR UPDATE ON episodic_memories
 FOR EACH ROW EXECUTE FUNCTION guard_episodic_promotion();

COMMIT;
