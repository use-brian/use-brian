BEGIN;

-- A connector's department is its audience (who may see it in Studio and
-- receive its tools), and a connector is born in its creator's home
-- department, the same rule migration 651 applies to memories, tasks and
-- files. A connector reaches a workspace two ways: a personal instance
-- exposed through connector_grant (the grant carries the labels), or a
-- workspace-owned connector_instance (the instance carries them). Both are
-- stamped on INSERT when they arrive with no department label. A reviewed
-- setup that chose General sets app.explicit_general for its transaction and
-- keeps General. Spec: docs/architecture/integrations/mcp.md ->
-- "Connector departments are an audience".

CREATE FUNCTION public.stamp_connector_department_home() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ws uuid; who uuid; home uuid;
BEGIN
  IF current_setting('app.explicit_general', true) = 'true' THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM unnest(coalesce(NEW.compartments, '{}'::text[])) k WHERE k LIKE 'team:%') THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'connector_grant' THEN
    IF NEW.target_type <> 'workspace' THEN RETURN NEW; END IF;
    ws := NEW.target_id;
    who := NEW.granted_by_user_id;
  ELSE
    IF NEW.scope <> 'workspace' THEN RETURN NEW; END IF;
    ws := NEW.workspace_id;
    who := NEW.created_by;
  END IF;
  IF ws IS NULL OR who IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = ws AND w.department_read_v2) THEN
    RETURN NEW;
  END IF;
  SELECT m.home_department_id INTO home FROM public.workspace_members m
   WHERE m.workspace_id = ws AND m.user_id = who;
  IF home IS NOT NULL THEN
    NEW.compartments := array_append(coalesce(NEW.compartments, '{}'::text[]), 'team:' || home::text);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.stamp_connector_department_home() FROM PUBLIC;

CREATE TRIGGER zzz_connector_department_home_stamp BEFORE INSERT ON public.connector_grant
  FOR EACH ROW EXECUTE FUNCTION public.stamp_connector_department_home();
CREATE TRIGGER zzz_connector_department_home_stamp BEFORE INSERT ON public.connector_instance
  FOR EACH ROW EXECUTE FUNCTION public.stamp_connector_department_home();

COMMIT;
