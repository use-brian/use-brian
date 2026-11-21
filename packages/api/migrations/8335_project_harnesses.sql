-- Engineering contracts only; no execution, approval, or new access boundary.
BEGIN;

ALTER TABLE public.project_shared_scopes ADD CONSTRAINT project_shared_scopes_workspace_project_unique UNIQUE (workspace_id, project_id);
CREATE TABLE public.project_harness_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 200),
  description text CHECK (length(description) <= 2000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id) REFERENCES public.project_shared_scopes(workspace_id, project_id) ON DELETE CASCADE,
  UNIQUE (workspace_id, project_id, id)
);
CREATE TABLE public.project_harness_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL, project_id uuid NOT NULL, product_id uuid NOT NULL,
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 200),
  description text CHECK (length(description) <= 2000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id, product_id) REFERENCES public.project_harness_products(workspace_id, project_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, project_id, product_id, id)
);
CREATE TABLE public.project_harness_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL, project_id uuid NOT NULL, product_id uuid, component_id uuid,
  scope_id uuid GENERATED ALWAYS AS (coalesce(component_id, product_id, project_id)) STORED,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  definition jsonb NOT NULL,
  -- Attribution is a snapshot, not an erasure-sensitive FK that mutates history.
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (component_id IS NULL OR product_id IS NOT NULL),
  FOREIGN KEY (workspace_id, project_id) REFERENCES public.project_shared_scopes(workspace_id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id, product_id) REFERENCES public.project_harness_products(workspace_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id, product_id, component_id) REFERENCES public.project_harness_components(workspace_id, project_id, product_id, id) ON DELETE CASCADE,
  UNIQUE (workspace_id, project_id, scope_id, revision)
);

-- Canonical department guards retain the General tier, credential binding,
-- assistant admission and read-only oversight semantics. No duplicated ACL map.
CREATE FUNCTION public.project_harness_visible(w uuid, p uuid, mutation boolean DEFAULT false)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.project_shared_scopes s JOIN public.workspaces wk ON wk.id=s.workspace_id
    JOIN public.workspace_members m ON m.workspace_id=wk.id
    WHERE s.workspace_id=w AND s.project_id=p AND s.status='active'
      AND wk.project_shared_spaces AND wk.department_read_v2
      AND m.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
      AND public.department_row_allows(public.department_read_grants(), w, 'internal', ARRAY['project:'||p::text], NULL::uuid)
      AND (NOT mutation OR public.member_operation_row_allows(public.member_operation_grants(true,w), w, 'internal', ARRAY['project:'||p::text]))
  )
$$;

-- All mutators use this order, including parent-status and authority rechecks.
-- Internal only: callers cannot use the definer helper as a visibility oracle.
CREATE FUNCTION public.project_harness_require(w uuid, p uuid, product uuid, component uuid, mutation boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor uuid := nullif(current_setting('app.current_user_id',true),'')::uuid; state text;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'harness_actor_required'; END IF;
  IF mutation THEN
    PERFORM 1 FROM public.workspaces WHERE id=w FOR UPDATE;
    PERFORM 1 FROM public.project_shared_scopes WHERE workspace_id=w AND project_id=p FOR UPDATE;
    PERFORM 1 FROM public.workspace_projects WHERE workspace_id=w AND id=p FOR UPDATE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.project_shared_scopes WHERE workspace_id=w AND project_id=p) THEN
    -- Legacy Projects have workspace visibility; never reveal another workspace.
    IF EXISTS (SELECT 1 FROM public.workspace_projects x JOIN public.workspace_members m ON m.workspace_id=x.workspace_id
      WHERE x.workspace_id=w AND x.id=p AND m.user_id=actor) THEN
      RAISE EXCEPTION 'harness_requires_shared_project';
    END IF;
    RAISE EXCEPTION 'harness_not_found';
  END IF;
  IF NOT public.project_harness_visible(w,p,false) THEN RAISE EXCEPTION 'harness_not_found'; END IF;
  IF mutation THEN
    IF NOT public.project_harness_visible(w,p,true) OR NOT EXISTS (
      SELECT 1 FROM public.project_shared_owners WHERE workspace_id=w AND project_id=p AND user_id=actor
    ) OR NOT public.project_member_live(p,'user',actor) THEN RAISE EXCEPTION 'harness_owner_required'; END IF;
    SELECT status INTO state FROM public.workspace_projects WHERE workspace_id=w AND id=p;
    IF state IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'harness_archived'; END IF;
  END IF;
  IF component IS NOT NULL AND product IS NULL THEN RAISE EXCEPTION 'harness_not_found'; END IF;
  IF product IS NOT NULL THEN
    IF mutation THEN PERFORM 1 FROM public.project_harness_products WHERE workspace_id=w AND project_id=p AND id=product FOR UPDATE; END IF;
    SELECT status INTO state FROM public.project_harness_products WHERE workspace_id=w AND project_id=p AND id=product;
    IF NOT FOUND THEN RAISE EXCEPTION 'harness_not_found'; END IF;
    IF mutation AND state <> 'active' THEN RAISE EXCEPTION 'harness_archived'; END IF;
  END IF;
  IF component IS NOT NULL THEN
    IF mutation THEN PERFORM 1 FROM public.project_harness_components WHERE workspace_id=w AND project_id=p AND product_id=product AND id=component FOR UPDATE; END IF;
    SELECT status INTO state FROM public.project_harness_components WHERE workspace_id=w AND project_id=p AND product_id=product AND id=component;
    IF NOT FOUND THEN RAISE EXCEPTION 'harness_not_found'; END IF;
    IF mutation AND state <> 'active' THEN RAISE EXCEPTION 'harness_archived'; END IF;
  END IF;
END $$;

-- Strict JSON validators also protect direct SQL commands. Store callers use
-- the shared Zod schemas first; SQL never reports values from the payload.
-- Match JavaScript string.length (UTF-16 units), not PostgreSQL code points.
CREATE FUNCTION public.project_harness_text_units(v jsonb) RETURNS integer
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE item jsonb; total integer := 0;
BEGIN
  IF jsonb_typeof(v)='string' THEN
    SELECT coalesce(sum(CASE WHEN ch='' THEN 0 WHEN ascii(ch)>65535 THEN 2 ELSE 1 END),0)::integer INTO total
      FROM regexp_split_to_table(v #>> '{}','') AS chars(ch);
  ELSIF jsonb_typeof(v)='array' THEN
    FOR item IN SELECT value FROM jsonb_array_elements(v) LOOP total := total + public.project_harness_text_units(item); END LOOP;
  ELSIF jsonb_typeof(v)='object' THEN
    FOR item IN SELECT value FROM jsonb_each(v) LOOP total := total + public.project_harness_text_units(item); END LOOP;
  END IF;
  RETURN total;
END $$;
CREATE FUNCTION public.project_harness_text(v jsonb, lo integer, hi integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  -- API writers normalize with JS trim(); direct SQL must supply canonical text.
  -- This list is ECMAScript WhiteSpace + LineTerminator, not just ASCII spaces.
  SELECT coalesce(jsonb_typeof(v)='string'
    AND (v #>> '{}')=btrim(v #>> '{}', U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
    AND public.project_harness_text_units(v) BETWEEN lo AND hi,false)
$$;
-- Match the optional source/dependency metadata schemas; references grant no
-- source access. Paths are canonical relative literals, never glob patterns.
CREATE FUNCTION public.project_harness_source_path_valid(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT public.project_harness_text(v,1,500)
   AND translate(v #>> '{}', E'\\:*?[]{}%', '') = v #>> '{}'
   AND (v #>> '{}') !~ U&'[\0001-\001F\007F]'
   AND NOT EXISTS(SELECT 1 FROM unnest(string_to_array(v #>> '{}','/')) segment WHERE segment IN ('','.','..'))
$$;
CREATE FUNCTION public.project_harness_scope_valid(v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE field text;
BEGIN
 IF v IS NULL OR jsonb_typeof(v)<>'object' THEN RETURN false; END IF;
 IF v->>'kind'='project' THEN RETURN v='{"kind":"project"}'::jsonb; END IF;
 IF coalesce(v->>'kind','') NOT IN ('product','component')
 OR v-(CASE WHEN v->>'kind'='product' THEN ARRAY['kind','productId'] ELSE ARRAY['kind','productId','componentId'] END)<>'{}'::jsonb THEN RETURN false; END IF;
 FOREACH field IN ARRAY (CASE WHEN v->>'kind'='product' THEN ARRAY['productId'] ELSE ARRAY['productId','componentId'] END) LOOP
  IF jsonb_typeof(v->field) IS DISTINCT FROM 'string' OR v->>field !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
CREATE FUNCTION public.project_harness_definition_valid(d jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE field text; item jsonb; criterion jsonb; value jsonb; keys text[]; ckeys text[]; k text;
BEGIN
  IF d IS NULL OR jsonb_typeof(d)<>'object' OR public.project_harness_text_units(d)>128000
    OR d->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR d - ARRAY['schemaVersion','rules','codeChecks','acceptanceScenarios','sourceMappings','dependencies'] <> '{}'::jsonb THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['sourceMappings','dependencies'] LOOP
    IF NOT d ? field THEN CONTINUE; END IF;
    IF jsonb_typeof(d->field) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(d->field)>100 THEN RETURN false; END IF;
    FOR item IN SELECT element.value FROM jsonb_array_elements(d->field) element LOOP
      IF jsonb_typeof(item)<>'object' THEN RETURN false; END IF;
      IF field='sourceMappings' THEN
        IF item-ARRAY['repository','pathPrefix']<>'{}'::jsonb OR NOT public.project_harness_text(item->'repository',1,200)
          OR NOT public.project_harness_source_path_valid(item->'pathPrefix') THEN RETURN false; END IF;
      ELSE
        IF item-ARRAY['scope','contract']<>'{}'::jsonb OR NOT public.project_harness_scope_valid(item->'scope')
          OR NOT public.project_harness_text(item->'contract',1,4000) THEN RETURN false; END IF;
      END IF;
    END LOOP;
  END LOOP;
  FOREACH field IN ARRAY ARRAY['rules','codeChecks','acceptanceScenarios'] LOOP
    IF jsonb_typeof(d->field) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(d->field)>(CASE field WHEN 'rules' THEN 100 WHEN 'codeChecks' THEN 50 ELSE 30 END) THEN RETURN false; END IF;
    keys := '{}';
    FOR item IN SELECT * FROM jsonb_array_elements(d->field) LOOP
      IF jsonb_typeof(item)<>'object' OR jsonb_typeof(item->'key') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
      k := item->>'key';
      IF k !~ '^[a-z][a-z0-9._-]{0,99}$' OR k=ANY(keys) THEN RETURN false; END IF;
      keys := array_append(keys,k);
      IF field='rules' THEN
        IF item-ARRAY['key','kind','value','override']<>'{}'::jsonb
          OR coalesce(item->>'kind','') NOT IN ('invariant','default','local')
          OR NOT public.project_harness_text(item->'value',1,4000)
          OR (item ? 'override' AND jsonb_typeof(item->'override')<>'boolean') THEN RETURN false; END IF;
      ELSIF field='codeChecks' THEN
        IF item-ARRAY['key','kind','instructions','command']<>'{}'::jsonb
          OR coalesce(item->>'kind','') NOT IN ('unit','integration','contract')
          OR NOT public.project_harness_text(item->'instructions',1,4000)
          OR (item ? 'command' AND NOT public.project_harness_text(item->'command',1,1000)) THEN RETURN false; END IF;
      ELSE
        IF item-ARRAY['key','title','preconditions','steps','criteria']<>'{}'::jsonb
          OR NOT public.project_harness_text(item->'title',1,200) THEN RETURN false; END IF;
        FOREACH k IN ARRAY ARRAY['preconditions','steps','criteria'] LOOP
          IF jsonb_typeof(item->k) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
          IF jsonb_array_length(item->k) NOT BETWEEN 1 AND (CASE k WHEN 'preconditions' THEN 30 ELSE 50 END) THEN RETURN false; END IF;
          IF k<>'criteria' THEN
            FOR value IN SELECT * FROM jsonb_array_elements(item->k) LOOP
              IF NOT public.project_harness_text(value,1,4000) THEN RETURN false; END IF;
            END LOOP;
          END IF;
        END LOOP;
        ckeys := '{}';
        FOR criterion IN SELECT * FROM jsonb_array_elements(item->'criteria') LOOP
          IF jsonb_typeof(criterion)<>'object' OR criterion-ARRAY['key','observation','evidence']<>'{}'::jsonb
            OR jsonb_typeof(criterion->'key') IS DISTINCT FROM 'string'
            OR criterion->>'key' !~ '^[a-z][a-z0-9._-]{0,99}$' OR criterion->>'key'=ANY(ckeys)
            OR NOT public.project_harness_text(criterion->'observation',1,4000)
            OR NOT public.project_harness_text(criterion->'evidence',1,4000) THEN RETURN false; END IF;
          ckeys := array_append(ckeys,criterion->>'key');
        END LOOP;
      END IF;
    END LOOP;
  END LOOP;
  RETURN true;
END $$;
ALTER TABLE public.project_harness_revisions ADD CONSTRAINT project_harness_definition_shape CHECK (public.project_harness_definition_valid(definition));

CREATE FUNCTION public.project_harness_immutable_parent() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR to_jsonb(NEW)->'product_id' IS DISTINCT FROM to_jsonb(OLD)->'product_id'
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'harness_parent_immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER project_harness_product_parent BEFORE UPDATE ON public.project_harness_products FOR EACH ROW EXECUTE FUNCTION public.project_harness_immutable_parent();
CREATE TRIGGER project_harness_component_parent BEFORE UPDATE ON public.project_harness_components FOR EACH ROW EXECUTE FUNCTION public.project_harness_immutable_parent();
CREATE FUNCTION public.project_harness_history_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id=OLD.workspace_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'harness_history_immutable';
END $$;
CREATE TRIGGER project_harness_revision_immutable BEFORE UPDATE OR DELETE ON public.project_harness_revisions FOR EACH ROW EXECUTE FUNCTION public.project_harness_history_immutable();

-- One bounded command for each node kind; no caller-supplied ancestry updates.
CREATE FUNCTION public.project_harness_write_node(w uuid, p uuid, product uuid, node uuid, patch jsonb, expected bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE oldrow jsonb; result jsonb;
BEGIN
  PERFORM public.project_harness_require(w,p,product,NULL,true);
  IF patch IS NULL OR jsonb_typeof(patch)<>'object' OR patch-ARRAY['name','description','status']<>'{}'::jsonb OR patch='{}'::jsonb
    OR (patch ? 'name' AND NOT public.project_harness_text(patch->'name',1,200))
    OR (patch ? 'description' AND patch->'description'<>'null'::jsonb AND NOT public.project_harness_text(patch->'description',0,2000))
    OR (patch ? 'status' AND coalesce(patch->>'status','') NOT IN ('active','archived')) THEN RAISE EXCEPTION 'harness_invalid_input'; END IF;
  IF node IS NULL THEN
    IF expected IS DISTINCT FROM 0::bigint OR NOT patch ? 'name' OR patch ? 'status' THEN RAISE EXCEPTION 'harness_invalid_input'; END IF;
    IF product IS NULL THEN
      INSERT INTO public.project_harness_products(workspace_id,project_id,name,description)
        VALUES(w,p,btrim(patch->>'name'),btrim(patch->>'description')) RETURNING to_jsonb(project_harness_products) INTO result;
    ELSE
      INSERT INTO public.project_harness_components(workspace_id,project_id,product_id,name,description)
        VALUES(w,p,product,btrim(patch->>'name'),btrim(patch->>'description')) RETURNING to_jsonb(project_harness_components) INTO result;
    END IF;
  ELSE
    IF product IS NULL THEN
      SELECT to_jsonb(x) INTO oldrow FROM public.project_harness_products x WHERE workspace_id=w AND project_id=p AND id=node FOR UPDATE;
    ELSE
      SELECT to_jsonb(x) INTO oldrow FROM public.project_harness_components x WHERE workspace_id=w AND project_id=p AND product_id=product AND id=node FOR UPDATE;
    END IF;
    IF oldrow IS NULL THEN RAISE EXCEPTION 'harness_not_found'; END IF;
    IF expected IS NULL OR expected<1 OR expected >= 9007199254740991 OR (oldrow->>'revision')::bigint<>expected THEN RAISE EXCEPTION 'harness_revision_stale'; END IF;
    -- An archived node can only be restored; archived ancestors cannot be bypassed.
    IF oldrow->>'status'='archived' AND patch IS DISTINCT FROM '{"status":"active"}'::jsonb THEN RAISE EXCEPTION 'harness_archived'; END IF;
    IF product IS NULL THEN
      UPDATE public.project_harness_products SET
        name=CASE WHEN patch ? 'name' THEN btrim(patch->>'name') ELSE name END,
        description=CASE WHEN patch ? 'description' THEN btrim(patch->>'description') ELSE description END,
        status=coalesce(patch->>'status',status),revision=revision+1,updated_at=now()
        WHERE workspace_id=w AND project_id=p AND id=node RETURNING to_jsonb(project_harness_products) INTO result;
    ELSE
      UPDATE public.project_harness_components SET
        name=CASE WHEN patch ? 'name' THEN btrim(patch->>'name') ELSE name END,
        description=CASE WHEN patch ? 'description' THEN btrim(patch->>'description') ELSE description END,
        status=coalesce(patch->>'status',status),revision=revision+1,updated_at=now()
        WHERE workspace_id=w AND project_id=p AND product_id=product AND id=node RETURNING to_jsonb(project_harness_components) INTO result;
    END IF;
  END IF;
  RETURN result;
END $$;

CREATE FUNCTION public.project_harness_put(w uuid, p uuid, product uuid, component uuid, expected bigint, body jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE current_revision bigint; result jsonb; dependency jsonb;
BEGIN
  PERFORM public.project_harness_require(w,p,product,component,true);
  IF NOT public.project_harness_definition_valid(body) THEN RAISE EXCEPTION 'harness_invalid_input'; END IF;
  -- The Project ancestry lock above serializes all node archive/definition
  -- mutations. Validate target existence in THIS Project, never follow IDs to
  -- another Project. Old immutable references may become unresolved on archive.
  FOR dependency IN SELECT value FROM jsonb_array_elements(coalesce(body->'dependencies','[]'::jsonb)) LOOP
    PERFORM public.project_harness_require(w,p,(dependency#>>'{scope,productId}')::uuid,
      (dependency#>>'{scope,componentId}')::uuid,true);
  END LOOP;
  SELECT coalesce(max(revision),0) INTO current_revision FROM public.project_harness_revisions
    WHERE workspace_id=w AND project_id=p AND product_id IS NOT DISTINCT FROM product AND component_id IS NOT DISTINCT FROM component;
  IF expected IS NULL OR expected<0 OR expected>=9007199254740991 OR current_revision<>expected THEN RAISE EXCEPTION 'harness_revision_stale'; END IF;
  INSERT INTO public.project_harness_revisions(workspace_id,project_id,product_id,component_id,revision,definition,created_by)
    VALUES(w,p,product,component,current_revision+1,body,nullif(current_setting('app.current_user_id',true),'')::uuid)
    RETURNING to_jsonb(project_harness_revisions) INTO result;
  RETURN result;
END $$;

-- Read commands always validate the complete target, even when no head exists.
-- The store runs them in one repeatable-read actor-bound transaction. History
-- retrieval is capped at 100 newest; older immutable snapshots remain retained.
CREATE FUNCTION public.project_harness_read(w uuid, p uuid, product uuid, component uuid, mode text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.project_harness_require(w,p,product,component,false);
  IF mode='tree' THEN
    RETURN jsonb_build_object('products',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY created_at,id) FROM public.project_harness_products x WHERE workspace_id=w AND project_id=p),'[]'::jsonb),
      'components',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY created_at,id) FROM public.project_harness_components x WHERE workspace_id=w AND project_id=p),'[]'::jsonb));
  ELSIF mode IN ('definition','history') THEN
    SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY revision DESC),'[]'::jsonb) INTO result FROM (
      SELECT * FROM public.project_harness_revisions WHERE workspace_id=w AND project_id=p
        AND product_id IS NOT DISTINCT FROM product AND component_id IS NOT DISTINCT FROM component
      ORDER BY revision DESC LIMIT CASE WHEN mode='history' THEN 100 ELSE 1 END) x;
    RETURN result;
  ELSIF mode='lineage' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY depth),'[]'::jsonb) INTO result FROM (
      SELECT DISTINCT ON (scope_id) r.*, CASE WHEN component_id IS NOT NULL THEN 2 WHEN product_id IS NOT NULL THEN 1 ELSE 0 END depth
      FROM public.project_harness_revisions r WHERE workspace_id=w AND project_id=p AND (
        (product_id IS NULL AND component_id IS NULL) OR (product_id=product AND component_id IS NULL)
        OR (product_id=product AND component_id=component)) ORDER BY scope_id,revision DESC) x;
    RETURN result;
  END IF;
  RAISE EXCEPTION 'harness_invalid_input';
END $$;

ALTER TABLE public.project_harness_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_harness_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_harness_revisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_harness_products_read ON public.project_harness_products FOR SELECT USING(public.project_harness_visible(workspace_id,project_id));
CREATE POLICY project_harness_components_read ON public.project_harness_components FOR SELECT USING(public.project_harness_visible(workspace_id,project_id));
CREATE POLICY project_harness_revisions_read ON public.project_harness_revisions FOR SELECT USING(public.project_harness_visible(workspace_id,project_id));

-- Do not inherit deployment-wide default DML or PUBLIC definer privileges.
REVOKE ALL ON public.project_harness_products, public.project_harness_components, public.project_harness_revisions FROM PUBLIC;
DO $$ DECLARE fn record; BEGIN
  FOR fn IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'project_harness_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM app_user',fn.signature);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
    REVOKE ALL ON public.project_harness_products, public.project_harness_components, public.project_harness_revisions FROM app_user;
    GRANT SELECT ON public.project_harness_products, public.project_harness_components, public.project_harness_revisions TO app_user;
    GRANT EXECUTE ON FUNCTION public.project_harness_visible(uuid,uuid,boolean), public.project_harness_read(uuid,uuid,uuid,uuid,text),
      public.project_harness_write_node(uuid,uuid,uuid,uuid,jsonb,bigint), public.project_harness_put(uuid,uuid,uuid,uuid,bigint,jsonb) TO app_user;
  END IF;
END $$;
COMMIT;
