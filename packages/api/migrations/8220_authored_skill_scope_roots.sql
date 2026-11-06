-- [COMP:api/skill-store] Preserve authored roots at native model-read boundaries.
BEGIN;
CREATE FUNCTION ensure_authored_skill_scope_root() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE receipt uuid;
BEGIN
 IF NEW.workspace_id IS NULL OR NEW.scope_revision_id IS NOT NULL OR NEW.write_origin<>'foreground'
   OR NEW.induction_source<>'authored' THEN RETURN NEW; END IF;
 INSERT INTO workspace_skill_scope_revisions(workspace_id,skill_id,revision,user_id,assistant_id,sensitivity,compartments,project_ids)
 VALUES(NEW.workspace_id,NEW.id,1,NULL,NULL,NEW.sensitivity,'{}','{}')
 ON CONFLICT(skill_id,revision) DO NOTHING RETURNING id INTO receipt;
 -- A missing head with pre-existing revisions is not an authored root. Do not
 -- substitute for or resurrect independently scoped/held derived content.
 IF receipt IS NOT NULL THEN
  UPDATE workspace_skills SET scope_revision_id=receipt WHERE id=NEW.id AND scope_revision_id IS NULL;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ensure_authored_skill_scope_root() FROM PUBLIC;
CREATE TRIGGER authored_skill_scope_root AFTER INSERT OR UPDATE ON workspace_skills
 FOR EACH ROW WHEN(NEW.scope_revision_id IS NULL) EXECUTE FUNCTION ensure_authored_skill_scope_root();
UPDATE workspace_skills SET scope_revision_id=scope_revision_id
 WHERE scope_revision_id IS NULL AND write_origin='foreground' AND induction_source='authored';
COMMIT;
