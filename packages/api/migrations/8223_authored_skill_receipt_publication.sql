-- [COMP:api/skill-store] Apply root revision publication after the human row's RLS check.
BEGIN;
CREATE OR REPLACE FUNCTION advance_authored_skill_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE receipt uuid;
BEGIN
 IF NEW.induction_source='authored' AND NEW.write_origin='foreground' AND OLD.scope_revision_id IS NOT NULL
   AND NEW.scope_revision_id IS NOT DISTINCT FROM OLD.scope_revision_id
   AND ROW(NEW.name,NEW.description,NEW.when_to_use,NEW.content,NEW.sensitivity,NEW.requires_connectors,NEW.bundle_version,NEW.source_digest)
     IS DISTINCT FROM ROW(OLD.name,OLD.description,OLD.when_to_use,OLD.content,OLD.sensitivity,OLD.requires_connectors,OLD.bundle_version,OLD.source_digest)
 THEN
   receipt:=renew_authored_skill_receipt(OLD.id,OLD.scope_revision_id,NEW.sensitivity);
   IF receipt IS DISTINCT FROM OLD.scope_revision_id THEN UPDATE workspace_skills SET scope_revision_id=receipt WHERE id=NEW.id; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER advance_authored_skill_receipt ON workspace_skills;
CREATE TRIGGER advance_authored_skill_receipt AFTER UPDATE ON workspace_skills FOR EACH ROW EXECUTE FUNCTION advance_authored_skill_receipt();
COMMIT;
