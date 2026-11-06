-- [COMP:api/skill-store] Retire stale authored bundle evidence on semantic changes.
BEGIN;
CREATE FUNCTION renew_authored_skill_receipt(skill uuid, previous uuid, tier text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE old_receipt workspace_skill_scope_revisions; receipt uuid;
BEGIN
 SELECT * INTO old_receipt FROM workspace_skill_scope_revisions WHERE id=previous AND skill_id=skill FOR UPDATE;
 IF old_receipt.id IS NULL OR old_receipt.scope_held OR EXISTS(
   SELECT 1 FROM scope_derivations WHERE workspace_id=old_receipt.workspace_id AND resource_kind='workspace_skill_revision' AND resource_id=previous)
   THEN RETURN previous; END IF;
 INSERT INTO workspace_skill_scope_revisions(workspace_id,skill_id,revision,user_id,assistant_id,sensitivity,compartments,project_ids)
 SELECT old_receipt.workspace_id,skill,coalesce(max(revision),0)+1,old_receipt.user_id,old_receipt.assistant_id,tier,old_receipt.compartments,old_receipt.project_ids
 FROM workspace_skill_scope_revisions WHERE skill_id=skill RETURNING id INTO receipt;
 PERFORM hold_scope_descendants(old_receipt.workspace_id,'workspace_skill_revision',previous);
 UPDATE workspace_skill_scope_revisions SET scope_held=true WHERE id=previous;
 RETURN receipt;
END $$;
REVOKE ALL ON FUNCTION renew_authored_skill_receipt(uuid,uuid,text) FROM PUBLIC;
CREATE FUNCTION advance_authored_skill_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.induction_source='authored' AND NEW.write_origin='foreground' AND OLD.scope_revision_id IS NOT NULL
   AND NEW.scope_revision_id IS NOT DISTINCT FROM OLD.scope_revision_id
   AND ROW(NEW.name,NEW.description,NEW.when_to_use,NEW.content,NEW.sensitivity,NEW.requires_connectors,NEW.bundle_version,NEW.source_digest)
     IS DISTINCT FROM ROW(OLD.name,OLD.description,OLD.when_to_use,OLD.content,OLD.sensitivity,OLD.requires_connectors,OLD.bundle_version,OLD.source_digest)
 THEN NEW.scope_revision_id:=renew_authored_skill_receipt(OLD.id,OLD.scope_revision_id,NEW.sensitivity); END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION advance_authored_skill_receipt() FROM PUBLIC;
CREATE TRIGGER advance_authored_skill_receipt BEFORE UPDATE ON workspace_skills FOR EACH ROW EXECUTE FUNCTION advance_authored_skill_receipt();
CREATE FUNCTION advance_authored_skill_resource_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE skill workspace_skills; receipt uuid; skill_id uuid;
BEGIN
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'updated_at') IS NOT DISTINCT FROM (to_jsonb(OLD)-'updated_at') THEN RETURN NEW; END IF;
 skill_id:=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_skill_id ELSE NEW.workspace_skill_id END;
 SELECT * INTO skill FROM workspace_skills WHERE id=skill_id FOR UPDATE;
 IF skill.induction_source='authored' AND skill.write_origin='foreground' AND skill.scope_revision_id IS NOT NULL THEN
   receipt:=renew_authored_skill_receipt(skill.id,skill.scope_revision_id,skill.sensitivity);
   IF receipt IS DISTINCT FROM skill.scope_revision_id THEN UPDATE workspace_skills SET scope_revision_id=receipt WHERE id=skill.id; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION advance_authored_skill_resource_receipt() FROM PUBLIC;
CREATE TRIGGER advance_authored_skill_resource_receipt AFTER INSERT OR UPDATE OR DELETE ON workspace_skill_files
 FOR EACH ROW EXECUTE FUNCTION advance_authored_skill_resource_receipt();
COMMIT;
