BEGIN;

-- One naming rule for signup, manual creation, upgrade and workspace rename.
CREATE FUNCTION public.workspace_primary_name(workspace_name text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,public AS $$
  WITH stem AS (
    SELECT btrim(regexp_replace(btrim(workspace_name), '([[:space:]]+|[''’]s[[:space:]]+)?\mworkspace$', '', 'i')) AS name
  )
  SELECT CASE WHEN name = '' THEN 'Brian'
    WHEN name ~* '(^|[[:space:]])Brian$' THEN name
    ELSE name || ' Brian' END FROM stem
$$;

UPDATE assistants a SET name = public.workspace_primary_name(w.name)
FROM workspaces w WHERE a.workspace_id = w.id AND a.kind = 'primary' AND a.name = w.name;

CREATE FUNCTION public.rename_default_workspace_primary() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE public.assistants SET name = public.workspace_primary_name(NEW.name), updated_at = now()
      WHERE workspace_id = NEW.id AND kind = 'primary'
        AND name IN (OLD.name, public.workspace_primary_name(OLD.name));
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_primary_name_follows_default
AFTER UPDATE OF name ON workspaces
FOR EACH ROW EXECUTE FUNCTION public.rename_default_workspace_primary();

COMMIT;
