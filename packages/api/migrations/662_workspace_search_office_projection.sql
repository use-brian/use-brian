BEGIN;

-- Reuse canonical Office ACLs and apply the current department rule to source
-- labels as well as the root. The definer sees denied source rows so they cannot
-- disappear from a NOT EXISTS check under the caller's RLS. Returns no metadata.
CREATE FUNCTION workspace_search_office_allows(artifact uuid,w uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM office_artifacts a
    WHERE a.id=artifact AND a.workspace_id=w
      AND a.mode='artifact' AND a.family IN ('document','presentation','spreadsheet')
      AND a.lifecycle_state IN ('active','archived')
      AND EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w
        AND m.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid)
      AND (a.creator_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
        OR a.owner_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
        OR a.default_workspace_role<>'deny'
        OR EXISTS(SELECT 1 FROM office_artifact_grants g WHERE g.artifact_id=a.id
          AND g.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND g.revoked_at IS NULL AND g.role<>'deny'))
      AND office_root_scope_allows(a.id,a.workspace_id,a.sensitivity,a.compartments,a.project_ids,a.visibility_user_ids,a.visibility_assistant_ids,false)
      AND department_row_allows((SELECT department_read_grants()),w,a.sensitivity,a.compartments,NULL::uuid)
      AND NOT EXISTS(SELECT 1 FROM office_artifact_sources s WHERE s.artifact_id=a.id AND s.retracted_at IS NULL
        AND NOT department_row_allows((SELECT department_read_grants()),w,s.sensitivity,s.required_compartments,NULL::uuid)))
$$;

-- Canonical Office text is projected asynchronously, never decoded by search.
-- Labels deliberately stay on the current artifact; this table grants no read.
CREATE TABLE workspace_search_office_text (
  artifact_id uuid PRIMARY KEY REFERENCES office_artifacts(id) ON DELETE CASCADE,
  revision text NOT NULL,
  body text NOT NULL,
  projected_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE workspace_search_office_text ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_search_office_read ON workspace_search_office_text FOR SELECT USING (
  EXISTS (SELECT 1 FROM office_artifacts a WHERE a.id=artifact_id AND workspace_search_office_allows(a.id,a.workspace_id))
);

CREATE TABLE workspace_search_office_queue (
  artifact_id uuid PRIMARY KEY REFERENCES office_artifacts(id) ON DELETE CASCADE,
  generation bigint NOT NULL DEFAULT 1,
  queued_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE workspace_search_office_queue ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION queue_workspace_search_office() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target uuid;
BEGIN
  IF TG_TABLE_NAME='office_artifacts' THEN target:=NEW.id;
  ELSE target:=NEW.artifact_id;
  END IF;
  INSERT INTO workspace_search_office_queue(artifact_id) VALUES(target)
    ON CONFLICT(artifact_id) DO UPDATE SET generation=workspace_search_office_queue.generation+1,queued_at=now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_search_office_root AFTER INSERT OR UPDATE OF head_version_id ON office_artifacts
  FOR EACH ROW EXECUTE FUNCTION queue_workspace_search_office();
CREATE TRIGGER workspace_search_office_live AFTER INSERT OR UPDATE OF ydoc ON office_collab_documents
  FOR EACH ROW EXECUTE FUNCTION queue_workspace_search_office();

-- Idempotent work queue: the worker projects one bounded batch per tick.
INSERT INTO workspace_search_office_queue(artifact_id)
  SELECT id FROM office_artifacts WHERE mode='artifact' AND family IN ('document','presentation','spreadsheet')
  ON CONFLICT(artifact_id) DO NOTHING;

CREATE INDEX workspace_search_office_queue_order ON workspace_search_office_queue(queued_at,artifact_id);
COMMIT;
