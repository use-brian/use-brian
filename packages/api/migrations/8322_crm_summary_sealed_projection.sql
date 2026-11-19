-- [COMP:crm/r2-store] Current CRM projections, exact release, and typed receipts.
-- Staged candidate on the 8318 continuation. Verify installed/portable contracts
-- before activating the application reader outside an owned local fixture.
BEGIN;
-- Scratch composition. Per-kind commit-ordered generation and exact scope
-- partition delta, including a now-empty class that previously had a record.

CREATE TABLE public.crm_summary_scope_partition_versions (
  workspace_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN('person','company','deal')),
  scope_class_id uuid NOT NULL,
  last_changed bigint NOT NULL CHECK (last_changed>0),
  PRIMARY KEY(workspace_id,kind,scope_class_id),
  FOREIGN KEY(workspace_id,scope_class_id) REFERENCES public.crm_summary_scope_classes(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX crm_summary_scope_partition_generations ON public.crm_summary_scope_partition_versions(workspace_id,kind,last_changed);
ALTER TABLE public.crm_summary_scope_partition_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crm_summary_scope_partition_versions FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_publish_partition_delta(w uuid, k text, s uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE generation bigint;
BEGIN
  IF s IS NULL OR NOT EXISTS(SELECT 1 FROM public.workspaces x WHERE x.id=w) THEN RETURN; END IF;
  -- Use an increment while holding this kind's single generation-row lock,
  -- never allocated sequence order. Commit inversion cannot hide a delta.
  INSERT INTO public.crm_summary_entity_domain_versions AS g(workspace_id,kind,revision) VALUES(w,k,1)
    ON CONFLICT(workspace_id,kind) DO UPDATE SET revision=g.revision+1 RETURNING revision INTO generation;
  INSERT INTO public.crm_summary_scope_partition_versions(workspace_id,kind,scope_class_id,last_changed)
    VALUES(w,k,s,generation) ON CONFLICT(workspace_id,kind,scope_class_id) DO UPDATE SET last_changed=EXCLUDED.last_changed;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_publish_partition_delta(uuid,text,uuid) FROM PUBLIC,app_user;

CREATE OR REPLACE FUNCTION public.crm_summary_entity_publication_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE previous_scope uuid; current_scope uuid;
BEGIN
  IF TG_OP='UPDATE' AND (OLD.workspace_id,OLD.kind,OLD.id,OLD.scope_version,OLD.scope_held,OLD.valid_to,OLD.retracted_at,
      OLD.user_id,OLD.assistant_id,OLD.sensitivity,OLD.compartments,OLD.project_ids,OLD.created_by_user_id,OLD.attributes,OLD.updated_at)
    IS NOT DISTINCT FROM (NEW.workspace_id,NEW.kind,NEW.id,NEW.scope_version,NEW.scope_held,NEW.valid_to,NEW.retracted_at,
      NEW.user_id,NEW.assistant_id,NEW.sensitivity,NEW.compartments,NEW.project_ids,NEW.created_by_user_id,NEW.attributes,NEW.updated_at) THEN RETURN NULL; END IF;
  -- A cascading physical deletion may already have removed the publication.
  -- Rebuild the old class from the authoritative old tuple if it was current.
  IF TG_OP<>'INSERT' AND OLD.kind IN('person','company','deal') AND OLD.workspace_id IS NOT NULL
    AND OLD.valid_to IS NULL AND OLD.retracted_at IS NULL AND NOT OLD.scope_held
    AND EXISTS(SELECT 1 FROM public.workspaces x WHERE x.id=OLD.workspace_id) THEN
    previous_scope:=public.crm_summary_entity_scope_class(OLD.workspace_id,OLD.user_id,OLD.assistant_id,OLD.sensitivity,OLD.compartments,OLD.project_ids);
  END IF;
  IF TG_OP='DELETE' OR TG_OP='UPDATE' AND (OLD.workspace_id,OLD.kind) IS DISTINCT FROM (NEW.workspace_id,NEW.kind) THEN
    DELETE FROM public.crm_summary_entity_publications p WHERE p.workspace_id=OLD.workspace_id AND p.entity_id=OLD.id;
  END IF;
  IF TG_OP<>'DELETE' THEN
    PERFORM public.crm_summary_publish_entity(NEW);
    SELECT p.scope_class_id INTO current_scope FROM public.crm_summary_entity_publications p
      WHERE p.workspace_id=NEW.workspace_id AND p.entity_id=NEW.id AND p.kind=NEW.kind;
  END IF;
  IF previous_scope IS NOT NULL AND (TG_OP='DELETE' OR current_scope IS NULL OR previous_scope<>current_scope
      OR (OLD.workspace_id,OLD.kind) IS DISTINCT FROM (NEW.workspace_id,NEW.kind)) THEN
    PERFORM public.crm_summary_publish_partition_delta(OLD.workspace_id,OLD.kind,previous_scope);
  END IF;
  IF current_scope IS NOT NULL THEN
    PERFORM public.crm_summary_publish_partition_delta(NEW.workspace_id,NEW.kind,current_scope);
  END IF;
  RETURN NULL;
END $$;

-- Scope-state changes can alter candidate membership without touching entity
-- version. Publish the source class in the same transaction in that case.
CREATE FUNCTION public.crm_summary_entity_scope_state_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w uuid; active_scope record;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.workspace_id,NEW.resource_kind,NEW.resource_id,NEW.review_state)
    IS NOT DISTINCT FROM (OLD.workspace_id,OLD.resource_kind,OLD.resource_id,OLD.review_state) THEN RETURN NULL; END IF;
  FOR active_scope IN SELECT DISTINCT p.workspace_id,p.kind,p.scope_class_id
    FROM public.crm_summary_entity_publications p WHERE
      (TG_OP<>'INSERT' AND OLD.resource_kind='entity' AND OLD.review_state='held' AND p.workspace_id=OLD.workspace_id AND p.entity_id=OLD.resource_id)
      OR (TG_OP<>'DELETE' AND NEW.resource_kind='entity' AND NEW.review_state='held' AND p.workspace_id=NEW.workspace_id AND p.entity_id=NEW.resource_id)
  LOOP
    PERFORM public.crm_summary_publish_partition_delta(active_scope.workspace_id,active_scope.kind,active_scope.scope_class_id);
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_entity_scope_state_changed() FROM PUBLIC,app_user;
CREATE TRIGGER crm_summary_entity_scope_state_changed AFTER INSERT OR UPDATE OR DELETE ON public.scope_resource_states
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_entity_scope_state_changed();

LOCK TABLE public.entities,public.scope_resource_states IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO public.crm_summary_scope_partition_versions(workspace_id,kind,scope_class_id,last_changed)
  SELECT DISTINCT p.workspace_id,p.kind,p.scope_class_id,g.revision FROM public.crm_summary_entity_publications p
   JOIN public.crm_summary_entity_domain_versions g ON g.workspace_id=p.workspace_id AND g.kind=p.kind;

CREATE FUNCTION public.crm_summary_scope_partition_admitted(w uuid, actor uuid, bounds jsonb,c public.crm_summary_scope_classes)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT (c.user_id IS NULL OR c.user_id=actor AND current_setting('app.agent_shared_audience',true) IS DISTINCT FROM 'true')
    AND public.agent_visibility_allows(w,c.user_id,c.assistant_id)
    AND public.application_reader_envelope_visible(w,jsonb_build_object('workspaceId',w,'userId',c.user_id,'assistantId',c.assistant_id,
      'sensitivity',c.sensitivity,'compartments',c.compartments,'projectIds',c.project_ids))
    AND public.application_query_scope_admits_point(bounds,jsonb_build_object('sensitivity',c.sensitivity,
      'compartments',c.compartments,'projectIds',c.project_ids))
$$;
REVOKE ALL ON FUNCTION public.crm_summary_scope_partition_admitted(uuid,uuid,jsonb,public.crm_summary_scope_classes) FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_domain_partitions_current(w uuid, actor uuid,bounds jsonb,captured jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT NOT EXISTS(
    SELECT 1 FROM public.crm_summary_entity_domain_versions g
    CROSS JOIN LATERAL (SELECT coalesce((captured->>g.kind)::bigint,0) AS prior) t
    WHERE g.workspace_id=w AND g.revision<>t.prior
      AND EXISTS(SELECT 1 FROM public.crm_summary_scope_partition_versions p
        JOIN public.crm_summary_scope_classes c ON c.workspace_id=p.workspace_id AND c.id=p.scope_class_id
        WHERE p.workspace_id=w AND p.kind=g.kind AND p.last_changed>t.prior
        AND public.crm_summary_scope_partition_admitted(w,actor,bounds,c) IS NOT FALSE))
$$;
REVOKE ALL ON FUNCTION public.crm_summary_domain_partitions_current(uuid,uuid,jsonb,jsonb) FROM PUBLIC,app_user;

CREATE OR REPLACE FUNCTION public.crm_summary_scope_partition_admitted(w uuid,actor uuid,bounds jsonb,c public.crm_summary_scope_classes)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT c.workspace_id=w AND actor IS NOT NULL AND public.crm_summary_scope_admitted(bounds,c)
$$;

-- Scratch writer-owned selected CRM cells. This is a derived, private read
-- representation whose rows identify the exact canonical current revision.

LOCK TABLE public.entities IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE public.crm_summary_selected_cells (
  workspace_id uuid NOT NULL,
  entity_id uuid NOT NULL,
  record_version bigint NOT NULL,
  valid boolean NOT NULL,
  archived boolean NOT NULL,
  company_id uuid,
  pipeline_id uuid,
  stage_id uuid,
  legacy_stage text,
  amount numeric,
  currency text,
  closes_date date,
  updated_at timestamptz,
  PRIMARY KEY(workspace_id,entity_id),
  FOREIGN KEY(workspace_id,entity_id) REFERENCES public.crm_summary_entity_publications(workspace_id,entity_id) ON DELETE CASCADE,
  CHECK (NOT valid OR (currency IS NOT NULL AND updated_at IS NOT NULL))
);
ALTER TABLE public.crm_summary_selected_cells ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crm_summary_selected_cells FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_selected_fields(k text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT CASE k WHEN 'company' THEN ARRAY['archivedAt'] WHEN 'person' THEN ARRAY['archivedAt','companyId']
    WHEN 'deal' THEN ARRAY['amount','archivedAt','closeDate','currencyCode','pipelineId','pipelineStageId','stage','updatedAt'] END
$$;
REVOKE ALL ON FUNCTION public.crm_summary_selected_fields(text) FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_decode_selected_cells(e public.entities) RETURNS public.crm_summary_selected_cells
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE cells jsonb; v text;
BEGIN
  cells:=public.application_native_entity_values(e.kind,to_jsonb(e),public.crm_summary_selected_fields(e.kind));
  v:=cells->>'amount';
  IF v IS NOT NULL AND (length(v)>100 OR v !~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,20})?$') THEN
    RAISE EXCEPTION 'invalid_value: canonical native amount requires review' USING ERRCODE='22023';
  END IF;
  IF v::numeric<0 THEN RAISE EXCEPTION 'invalid_value: negative native amount' USING ERRCODE='22023'; END IF;
  RETURN ROW(e.workspace_id,e.id,e.scope_version,true,cells->>'archivedAt' IS NOT NULL,(cells->>'companyId')::uuid,
    (cells->>'pipelineId')::uuid,(cells->>'pipelineStageId')::uuid,cells->>'stage',v::numeric,
    coalesce(nullif(upper(cells->>'currencyCode'),''),'USD'),nullif(cells->>'closeDate','')::date,coalesce((cells->>'updatedAt')::timestamptz,e.updated_at))::public.crm_summary_selected_cells;
EXCEPTION WHEN invalid_parameter_value OR invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation OR numeric_value_out_of_range THEN
  -- Historical malformed business input retains the downstream refusal.
  -- Its presence must not prevent installing on other scopes or records.
  RETURN ROW(e.workspace_id,e.id,e.scope_version,false,false,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)::public.crm_summary_selected_cells;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_decode_selected_cells(public.entities) FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_selected_cells_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE cells public.crm_summary_selected_cells;
BEGIN
  IF NEW.workspace_id IS NULL OR NEW.kind NOT IN('company','person','deal') OR NEW.scope_held
    OR NEW.valid_to IS NOT NULL OR NEW.retracted_at IS NOT NULL THEN RETURN NULL; END IF;
  IF TG_OP='UPDATE' AND (OLD.workspace_id,OLD.kind,OLD.id,OLD.scope_version,OLD.attributes,OLD.updated_at,OLD.scope_held,OLD.valid_to,OLD.retracted_at)
    IS NOT DISTINCT FROM (NEW.workspace_id,NEW.kind,NEW.id,NEW.scope_version,NEW.attributes,NEW.updated_at,NEW.scope_held,NEW.valid_to,NEW.retracted_at)
    THEN RETURN NULL; END IF;
  cells:=public.crm_summary_decode_selected_cells(NEW);
  INSERT INTO public.crm_summary_selected_cells SELECT (cells).* ON CONFLICT(workspace_id,entity_id) DO UPDATE SET
    (record_version,valid,archived,company_id,pipeline_id,stage_id,legacy_stage,amount,currency,closes_date,updated_at)=
    (excluded.record_version,excluded.valid,excluded.archived,excluded.company_id,excluded.pipeline_id,excluded.stage_id,
      excluded.legacy_stage,excluded.amount,excluded.currency,excluded.closes_date,excluded.updated_at);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_selected_cells_changed() FROM PUBLIC,app_user;
CREATE TRIGGER crm_summary_selected_cells_changed AFTER INSERT OR UPDATE ON public.entities
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_selected_cells_changed();
INSERT INTO public.crm_summary_selected_cells
  SELECT cells.* FROM public.crm_summary_entity_publications p JOIN public.entities e ON e.workspace_id=p.workspace_id AND e.id=p.entity_id
  CROSS JOIN LATERAL public.crm_summary_decode_selected_cells(e) cells;

-- Scratch writer-side exact partition roots. A root names the set of original
-- physical revisions at its generation, including final zero-member states.

LOCK TABLE public.entities,public.scope_resource_states IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE public.crm_summary_partition_leaves (
  workspace_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN('person','company','deal')),
  scope_class_id uuid NOT NULL,
  entity_id uuid NOT NULL,
  record_version bigint NOT NULL,
  visible_from bigint NOT NULL,
  visible_until bigint,
  selected_digest text NOT NULL CHECK(selected_digest ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY(workspace_id,kind,scope_class_id,entity_id,visible_from),
  FOREIGN KEY(workspace_id,scope_class_id) REFERENCES public.crm_summary_scope_classes(workspace_id,id) ON DELETE CASCADE,
  CHECK(visible_until IS NULL OR visible_until>visible_from)
);
CREATE UNIQUE INDEX crm_summary_partition_leaves_one_current ON public.crm_summary_partition_leaves(workspace_id,entity_id)
  WHERE visible_until IS NULL;
CREATE INDEX crm_summary_partition_leaves_current_scope ON public.crm_summary_partition_leaves(workspace_id,kind,scope_class_id)
  WHERE visible_until IS NULL;
ALTER TABLE public.crm_summary_partition_leaves ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crm_summary_partition_leaves FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_selected_cells_digest(c public.crm_summary_selected_cells) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT public.application_field_digest(jsonb_build_array(c.valid,c.archived,c.company_id,c.pipeline_id,c.stage_id,
    c.legacy_stage,c.amount,c.currency,c.closes_date,extract(epoch FROM c.updated_at)))
$$;
REVOKE ALL ON FUNCTION public.crm_summary_selected_cells_digest(public.crm_summary_selected_cells) FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_preserve_partition_leaf(w uuid,i uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE original public.crm_summary_partition_leaves;
DECLARE proposed record;
DECLARE prior_generation bigint;
BEGIN
  SELECT l.* INTO original FROM public.crm_summary_partition_leaves l WHERE l.workspace_id=w AND l.entity_id=i AND l.visible_until IS NULL;
  SELECT p.kind,p.scope_class_id,p.record_version,g.last_changed,
    public.crm_summary_selected_cells_digest(c) AS selected_digest INTO proposed
  FROM public.crm_summary_entity_publications p JOIN public.crm_summary_selected_cells c
    ON c.workspace_id=p.workspace_id AND c.entity_id=p.entity_id AND c.record_version=p.record_version
  JOIN public.crm_summary_scope_partition_versions g ON g.workspace_id=p.workspace_id AND g.kind=p.kind AND g.scope_class_id=p.scope_class_id
  WHERE p.workspace_id=w AND p.entity_id=i AND NOT EXISTS(SELECT 1 FROM public.scope_resource_states r
    WHERE r.workspace_id=w AND r.resource_kind='entity' AND r.resource_id=i AND r.review_state='held');
  IF original.entity_id IS NOT NULL AND (original.kind,original.scope_class_id,original.record_version,original.selected_digest)
    IS NOT DISTINCT FROM (proposed.kind,proposed.scope_class_id,proposed.record_version,proposed.selected_digest) THEN RETURN; END IF;
  IF original.entity_id IS NOT NULL THEN
    SELECT p.last_changed INTO prior_generation FROM public.crm_summary_scope_partition_versions p
      WHERE p.workspace_id=w AND p.kind=original.kind AND p.scope_class_id=original.scope_class_id;
    IF prior_generation IS NULL OR prior_generation<=original.visible_from THEN
      RAISE EXCEPTION 'crm_summary_partition_owner_generation_missing' USING ERRCODE='55000'; END IF;
    UPDATE public.crm_summary_partition_leaves l SET visible_until=prior_generation WHERE l.workspace_id=w AND l.entity_id=i AND l.visible_until IS NULL;
  END IF;
  IF proposed.kind IS NOT NULL THEN
    INSERT INTO public.crm_summary_partition_leaves(workspace_id,kind,scope_class_id,entity_id,record_version,visible_from,selected_digest)
      VALUES(w,proposed.kind,proposed.scope_class_id,i,proposed.record_version,proposed.last_changed,proposed.selected_digest);
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_preserve_partition_leaf(uuid,uuid) FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_preserve_partition_leaf_after_entity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' OR TG_OP='UPDATE' AND (OLD.workspace_id,OLD.id) IS DISTINCT FROM (NEW.workspace_id,NEW.id) THEN
    IF OLD.workspace_id IS NOT NULL AND OLD.kind IN('person','company','deal')
      AND EXISTS(SELECT 1 FROM public.workspaces w WHERE w.id=OLD.workspace_id) THEN
      PERFORM public.crm_summary_preserve_partition_leaf(OLD.workspace_id,OLD.id); END IF;
  END IF;
  IF TG_OP<>'DELETE' AND NEW.workspace_id IS NOT NULL AND NEW.kind IN('person','company','deal') THEN
    PERFORM public.crm_summary_preserve_partition_leaf(NEW.workspace_id,NEW.id);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_preserve_partition_leaf_after_entity() FROM PUBLIC,app_user;
CREATE TRIGGER crm_summary_z_preserve_partition_leaf_after_entity AFTER INSERT OR UPDATE OR DELETE ON public.entities
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_preserve_partition_leaf_after_entity();

CREATE FUNCTION public.crm_summary_preserve_partition_leaf_after_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP<>'INSERT' AND OLD.resource_kind='entity' AND OLD.review_state='held'
    AND EXISTS(SELECT 1 FROM public.workspaces w WHERE w.id=OLD.workspace_id) THEN
    PERFORM public.crm_summary_preserve_partition_leaf(OLD.workspace_id,OLD.resource_id); END IF;
  IF TG_OP<>'DELETE' AND NEW.resource_kind='entity' AND NEW.review_state='held' THEN
    PERFORM public.crm_summary_preserve_partition_leaf(NEW.workspace_id,NEW.resource_id); END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_preserve_partition_leaf_after_review() FROM PUBLIC,app_user;
CREATE TRIGGER crm_summary_z_preserve_partition_leaf_after_review AFTER INSERT OR UPDATE OR DELETE ON public.scope_resource_states
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_preserve_partition_leaf_after_review();

INSERT INTO public.crm_summary_partition_leaves(workspace_id,kind,scope_class_id,entity_id,record_version,visible_from,selected_digest)
  SELECT p.workspace_id,p.kind,p.scope_class_id,p.entity_id,p.record_version,g.last_changed,public.crm_summary_selected_cells_digest(c)
  FROM public.crm_summary_entity_publications p JOIN public.crm_summary_selected_cells c USING(workspace_id,entity_id,record_version)
  JOIN public.crm_summary_scope_partition_versions g USING(workspace_id,kind,scope_class_id)
  WHERE NOT EXISTS(SELECT 1 FROM public.scope_resource_states r WHERE r.workspace_id=p.workspace_id AND r.resource_kind='entity'
    AND r.resource_id=p.entity_id AND r.review_state='held');

-- Writer-owned exact aggregate contributions. Counter keys contain only fields
-- that affect the summary. Temporal attention uses exact date/time coordinates.

LOCK TABLE public.entities,public.scope_resource_states IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE public.crm_summary_rollup_leaves (
  workspace_id uuid NOT NULL,
  entity_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN('person','company','deal')),
  scope_class_id uuid NOT NULL,
  record_version bigint NOT NULL,
  valid boolean NOT NULL,
  archived boolean NOT NULL,
  company_id uuid,
  pipeline_id uuid,
  stage_id uuid,
  legacy_open boolean NOT NULL,
  currency text NOT NULL,
  amount numeric,
  closes_date date,
  updated_at timestamptz,
  PRIMARY KEY(workspace_id,entity_id),
  FOREIGN KEY(workspace_id,scope_class_id) REFERENCES public.crm_summary_scope_classes(workspace_id,id) ON DELETE CASCADE
);
CREATE TABLE public.crm_summary_rollups (
  workspace_id uuid NOT NULL,
  kind text NOT NULL,
  scope_class_id uuid NOT NULL,
  pipeline_id uuid,
  stage_id uuid,
  legacy_open boolean NOT NULL,
  currency text NOT NULL,
  observations bigint NOT NULL CHECK(observations>=0),
  active_rows bigint NOT NULL CHECK(active_rows>=0),
  invalid_rows bigint NOT NULL CHECK(invalid_rows>=0),
  valued_rows bigint NOT NULL CHECK(valued_rows>=0),
  amount_total numeric NOT NULL,
  orphaned_rows bigint NOT NULL CHECK(orphaned_rows>=0),
  FOREIGN KEY(workspace_id,scope_class_id) REFERENCES public.crm_summary_scope_classes(workspace_id,id) ON DELETE CASCADE,
  UNIQUE NULLS NOT DISTINCT(workspace_id,kind,scope_class_id,pipeline_id,stage_id,legacy_open,currency)
);
CREATE INDEX crm_summary_rollups_domain ON public.crm_summary_rollups(workspace_id,kind,scope_class_id);
CREATE TABLE public.crm_summary_attention_rollups (
  workspace_id uuid NOT NULL,
  scope_class_id uuid NOT NULL,
  pipeline_id uuid,
  stage_id uuid,
  legacy_open boolean NOT NULL,
  metric text NOT NULL CHECK(metric IN('close','stale')),
  coordinate bigint NOT NULL,
  contributing_rows bigint NOT NULL CHECK(contributing_rows>=0),
  FOREIGN KEY(workspace_id,scope_class_id) REFERENCES public.crm_summary_scope_classes(workspace_id,id) ON DELETE CASCADE,
  UNIQUE NULLS NOT DISTINCT(workspace_id,scope_class_id,pipeline_id,stage_id,legacy_open,metric,coordinate)
);
CREATE TABLE public.crm_summary_company_references (
  workspace_id uuid NOT NULL,
  scope_class_id uuid NOT NULL,
  company_id uuid NOT NULL,
  source_count bigint NOT NULL CHECK(source_count>=0),
  PRIMARY KEY(workspace_id,scope_class_id,company_id),
  FOREIGN KEY(workspace_id,scope_class_id) REFERENCES public.crm_summary_scope_classes(workspace_id,id) ON DELETE CASCADE
);
ALTER TABLE public.crm_summary_rollup_leaves ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_summary_rollups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_summary_attention_rollups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_summary_company_references ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crm_summary_rollup_leaves,public.crm_summary_rollups,public.crm_summary_attention_rollups,
  public.crm_summary_company_references FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_shift_rollup(p public.crm_summary_rollup_leaves,delta smallint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE active bigint:=CASE WHEN p.archived THEN 0 ELSE 1 END;
DECLARE invalid bigint:=CASE WHEN p.valid THEN 0 ELSE 1 END;
DECLARE valued bigint:=CASE WHEN p.amount IS NULL THEN 0 ELSE active END;
DECLARE total numeric:=coalesce(p.amount*valued,0);
DECLARE orphaned bigint:=CASE WHEN p.kind='person' AND p.company_id IS NULL THEN active ELSE 0 END;
DECLARE when_value record;
BEGIN
  IF delta=1 THEN
    INSERT INTO public.crm_summary_rollups AS r(workspace_id,kind,scope_class_id,pipeline_id,stage_id,legacy_open,currency,
      observations,active_rows,invalid_rows,valued_rows,amount_total,orphaned_rows)
    VALUES(p.workspace_id,p.kind,p.scope_class_id,p.pipeline_id,p.stage_id,p.legacy_open,p.currency,1,active,invalid,valued,total,orphaned)
    ON CONFLICT(workspace_id,kind,scope_class_id,pipeline_id,stage_id,legacy_open,currency) DO UPDATE SET
      observations=r.observations+1,active_rows=r.active_rows+active,invalid_rows=r.invalid_rows+invalid,
      valued_rows=r.valued_rows+valued,amount_total=r.amount_total+total,orphaned_rows=r.orphaned_rows+orphaned;
  ELSE
    UPDATE public.crm_summary_rollups r SET observations=r.observations-1,active_rows=r.active_rows-active,invalid_rows=r.invalid_rows-invalid,
      valued_rows=r.valued_rows-valued,amount_total=r.amount_total-total,orphaned_rows=r.orphaned_rows-orphaned
    WHERE r.workspace_id=p.workspace_id AND r.kind=p.kind AND r.scope_class_id=p.scope_class_id AND r.currency=p.currency
      AND r.pipeline_id IS NOT DISTINCT FROM p.pipeline_id AND r.stage_id IS NOT DISTINCT FROM p.stage_id AND r.legacy_open=p.legacy_open;
    IF NOT FOUND THEN RAISE EXCEPTION 'crm_summary_rollup_original_missing'; END IF;
    DELETE FROM public.crm_summary_rollups r WHERE r.workspace_id=p.workspace_id AND r.kind=p.kind AND r.scope_class_id=p.scope_class_id
      AND r.currency=p.currency AND r.pipeline_id IS NOT DISTINCT FROM p.pipeline_id AND r.stage_id IS NOT DISTINCT FROM p.stage_id
      AND r.legacy_open=p.legacy_open AND r.observations=0;
  END IF;
  IF p.kind='person' AND p.company_id IS NOT NULL THEN
    IF delta=1 THEN
      INSERT INTO public.crm_summary_company_references AS r(workspace_id,scope_class_id,company_id,source_count)
      VALUES(p.workspace_id,p.scope_class_id,p.company_id,1) ON CONFLICT(workspace_id,scope_class_id,company_id)
      DO UPDATE SET source_count=r.source_count+1;
    ELSE
      UPDATE public.crm_summary_company_references r SET source_count=r.source_count-1 WHERE r.workspace_id=p.workspace_id
        AND r.scope_class_id=p.scope_class_id AND r.company_id=p.company_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'crm_summary_company_reference_original_missing'; END IF;
      DELETE FROM public.crm_summary_company_references r WHERE r.workspace_id=p.workspace_id AND r.scope_class_id=p.scope_class_id
        AND r.company_id=p.company_id AND r.source_count=0;
    END IF;
  END IF;
  IF p.kind='deal' AND active=1 THEN
    FOR when_value IN SELECT * FROM (VALUES ('close',(p.closes_date-DATE '1970-01-01')::bigint),
      ('stale',(extract(epoch FROM p.updated_at)*1000000)::bigint)) v(metric,coordinate) WHERE coordinate IS NOT NULL LOOP
      IF delta=1 THEN
        INSERT INTO public.crm_summary_attention_rollups AS r(workspace_id,scope_class_id,pipeline_id,stage_id,legacy_open,metric,coordinate,contributing_rows)
          VALUES(p.workspace_id,p.scope_class_id,p.pipeline_id,p.stage_id,p.legacy_open,when_value.metric,when_value.coordinate,1)
        ON CONFLICT(workspace_id,scope_class_id,pipeline_id,stage_id,legacy_open,metric,coordinate)
        DO UPDATE SET contributing_rows=r.contributing_rows+1;
      ELSE
        UPDATE public.crm_summary_attention_rollups r SET contributing_rows=r.contributing_rows-1
        WHERE r.workspace_id=p.workspace_id AND r.scope_class_id=p.scope_class_id AND r.metric=when_value.metric AND r.coordinate=when_value.coordinate
          AND r.pipeline_id IS NOT DISTINCT FROM p.pipeline_id AND r.stage_id IS NOT DISTINCT FROM p.stage_id AND r.legacy_open=p.legacy_open;
        IF NOT FOUND THEN RAISE EXCEPTION 'crm_summary_attention_original_missing'; END IF;
        DELETE FROM public.crm_summary_attention_rollups r WHERE r.workspace_id=p.workspace_id AND r.scope_class_id=p.scope_class_id
          AND r.metric=when_value.metric AND r.coordinate=when_value.coordinate AND r.pipeline_id IS NOT DISTINCT FROM p.pipeline_id
          AND r.stage_id IS NOT DISTINCT FROM p.stage_id AND r.legacy_open=p.legacy_open AND r.contributing_rows=0;
      END IF;
    END LOOP;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_shift_rollup(public.crm_summary_rollup_leaves,smallint) FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_publish_rollup_leaf(w uuid,i uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE original public.crm_summary_rollup_leaves;
DECLARE proposed public.crm_summary_rollup_leaves;
BEGIN
  SELECT l.* INTO original FROM public.crm_summary_rollup_leaves l WHERE l.workspace_id=w AND l.entity_id=i;
  SELECT p.workspace_id,p.entity_id,p.kind,p.scope_class_id,p.record_version,c.valid,c.archived,c.company_id,c.pipeline_id,c.stage_id,
    coalesce(c.legacy_stage,'lead') NOT IN('won','lost'),coalesce(c.currency,'USD'),c.amount,c.closes_date,c.updated_at INTO proposed
  FROM public.crm_summary_entity_publications p JOIN public.crm_summary_selected_cells c USING(workspace_id,entity_id,record_version)
  WHERE p.workspace_id=w AND p.entity_id=i AND NOT EXISTS(SELECT 1 FROM public.scope_resource_states r
    WHERE r.workspace_id=w AND r.resource_kind='entity' AND r.resource_id=i AND r.review_state='held');
  IF original IS NOT DISTINCT FROM proposed THEN RETURN; END IF;
  IF original.entity_id IS NOT NULL THEN
    PERFORM public.crm_summary_shift_rollup(original,(-1)::smallint);
    DELETE FROM public.crm_summary_rollup_leaves l WHERE l.workspace_id=w AND l.entity_id=i;
  END IF;
  IF proposed.entity_id IS NOT NULL THEN
    INSERT INTO public.crm_summary_rollup_leaves SELECT (proposed).*;
    PERFORM public.crm_summary_shift_rollup(proposed,1::smallint);
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_publish_rollup_leaf(uuid,uuid) FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_rollup_after_entity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' OR TG_OP='UPDATE' AND (OLD.workspace_id,OLD.id) IS DISTINCT FROM (NEW.workspace_id,NEW.id) THEN
    IF OLD.workspace_id IS NOT NULL AND OLD.kind IN('person','company','deal')
      AND EXISTS(SELECT 1 FROM public.workspaces w WHERE w.id=OLD.workspace_id) THEN
      PERFORM public.crm_summary_publish_rollup_leaf(OLD.workspace_id,OLD.id); END IF;
  END IF;
  IF TG_OP<>'DELETE' AND NEW.workspace_id IS NOT NULL AND NEW.kind IN('person','company','deal') THEN
    PERFORM public.crm_summary_publish_rollup_leaf(NEW.workspace_id,NEW.id);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_rollup_after_entity() FROM PUBLIC,app_user;
CREATE TRIGGER crm_summary_zz_rollup_after_entity AFTER INSERT OR UPDATE OR DELETE ON public.entities
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_rollup_after_entity();

CREATE FUNCTION public.crm_summary_rollup_after_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP<>'INSERT' AND OLD.resource_kind='entity' AND OLD.review_state='held'
    AND EXISTS(SELECT 1 FROM public.workspaces w WHERE w.id=OLD.workspace_id) THEN
    PERFORM public.crm_summary_publish_rollup_leaf(OLD.workspace_id,OLD.resource_id); END IF;
  IF TG_OP<>'DELETE' AND NEW.resource_kind='entity' AND NEW.review_state='held' THEN
    PERFORM public.crm_summary_publish_rollup_leaf(NEW.workspace_id,NEW.resource_id); END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_rollup_after_review() FROM PUBLIC,app_user;
CREATE TRIGGER crm_summary_zz_rollup_after_review AFTER INSERT OR UPDATE OR DELETE ON public.scope_resource_states
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_rollup_after_review();

-- One grouped in-transaction bootstrap for retained data. Normal entity writers
-- maintain only their own previous/new typed contribution and exact scopes.
INSERT INTO public.crm_summary_rollup_leaves SELECT p.workspace_id,p.entity_id,p.kind,p.scope_class_id,p.record_version,c.valid,c.archived,
  c.company_id,c.pipeline_id,c.stage_id,coalesce(c.legacy_stage,'lead') NOT IN('won','lost'),coalesce(c.currency,'USD'),
  c.amount,c.closes_date,c.updated_at FROM public.crm_summary_entity_publications p JOIN public.crm_summary_selected_cells c USING(workspace_id,entity_id,record_version)
  WHERE NOT EXISTS(SELECT 1 FROM public.scope_resource_states r WHERE r.workspace_id=p.workspace_id AND r.resource_kind='entity'
    AND r.resource_id=p.entity_id AND r.review_state='held');
INSERT INTO public.crm_summary_rollups
  SELECT workspace_id,kind,scope_class_id,pipeline_id,stage_id,legacy_open,currency,count(*),count(*) FILTER(WHERE NOT archived),
    count(*) FILTER(WHERE NOT valid),count(amount) FILTER(WHERE NOT archived),coalesce(sum(amount) FILTER(WHERE NOT archived),0),
    count(*) FILTER(WHERE NOT archived AND kind='person' AND company_id IS NULL)
  FROM public.crm_summary_rollup_leaves GROUP BY workspace_id,kind,scope_class_id,pipeline_id,stage_id,legacy_open,currency;
INSERT INTO public.crm_summary_attention_rollups
  SELECT p.workspace_id,p.scope_class_id,p.pipeline_id,p.stage_id,p.legacy_open,v.metric,v.coordinate,count(*)
  FROM public.crm_summary_rollup_leaves p CROSS JOIN LATERAL (VALUES ('close',(p.closes_date-DATE '1970-01-01')::bigint),
    ('stale',(extract(epoch FROM p.updated_at)*1000000)::bigint)) v(metric,coordinate)
  WHERE p.kind='deal' AND NOT p.archived AND v.coordinate IS NOT NULL
  GROUP BY p.workspace_id,p.scope_class_id,p.pipeline_id,p.stage_id,p.legacy_open,v.metric,v.coordinate;
INSERT INTO public.crm_summary_company_references
  SELECT workspace_id,scope_class_id,company_id,count(*) FROM public.crm_summary_rollup_leaves
  WHERE kind='person' AND company_id IS NOT NULL GROUP BY workspace_id,scope_class_id,company_id;

-- Only actual distinct registered policy dependencies are evaluated at read.
-- A record or enrollment write maintains its owning scope membership count.

LOCK TABLE public.crm_summary_rollup_leaves,public.crm_summary_record_policies IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE public.crm_summary_scope_policy_usage (
  workspace_id uuid NOT NULL,
  resource_type text NOT NULL,
  scope_class_id uuid NOT NULL,
  policy_key text NOT NULL,
  reference_count bigint NOT NULL CHECK(reference_count>=0),
  PRIMARY KEY(workspace_id,resource_type,scope_class_id,policy_key),
  FOREIGN KEY(workspace_id,scope_class_id) REFERENCES public.crm_summary_scope_classes(workspace_id,id) ON DELETE CASCADE
);
ALTER TABLE public.crm_summary_scope_policy_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crm_summary_scope_policy_usage FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_shift_scope_policy(w uuid,t text,s uuid,p text,delta int) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF delta>0 THEN
    INSERT INTO public.crm_summary_scope_policy_usage AS x(workspace_id,resource_type,scope_class_id,policy_key,reference_count)
      VALUES(w,t,s,p,1) ON CONFLICT(workspace_id,resource_type,scope_class_id,policy_key)
      DO UPDATE SET reference_count=x.reference_count+1;
  ELSE
    UPDATE public.crm_summary_scope_policy_usage x SET reference_count=x.reference_count-1
      WHERE x.workspace_id=w AND x.resource_type=t AND x.scope_class_id=s AND x.policy_key=p;
    DELETE FROM public.crm_summary_scope_policy_usage x WHERE x.workspace_id=w AND x.resource_type=t
      AND x.scope_class_id=s AND x.policy_key=p AND x.reference_count=0;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_shift_scope_policy(uuid,text,uuid,text,int) FROM PUBLIC,app_user;

-- Enrollment, record mutation and externally managed holds serialize on the
-- same canonical record before reading or shifting the scope membership edge.
CREATE FUNCTION public.crm_summary_scope_policy_lock_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE old_id uuid;
DECLARE new_id uuid;
BEGIN
  IF TG_TABLE_NAME='crm_summary_record_policies' THEN
    IF TG_OP<>'INSERT' THEN old_id:=OLD.record_id; END IF;
    IF TG_OP<>'DELETE' THEN new_id:=NEW.record_id; END IF;
  ELSE
    IF TG_OP<>'INSERT' AND OLD.resource_kind='entity' THEN old_id:=OLD.resource_id; END IF;
    IF TG_OP<>'DELETE' AND NEW.resource_kind='entity' THEN new_id:=NEW.resource_id; END IF;
  END IF;
  PERFORM e.id FROM public.entities e WHERE e.id IN(old_id,new_id) ORDER BY e.id FOR NO KEY UPDATE;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_scope_policy_lock_record() FROM PUBLIC,app_user;
CREATE TRIGGER crm_summary_scope_policy_lock_enrollment BEFORE INSERT OR UPDATE OR DELETE ON public.crm_summary_record_policies
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_scope_policy_lock_record();
CREATE TRIGGER crm_summary_scope_policy_lock_review BEFORE INSERT OR UPDATE OR DELETE ON public.scope_resource_states
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_scope_policy_lock_record();

CREATE FUNCTION public.crm_summary_scope_policy_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE entry record;
BEGIN
  IF TG_TABLE_NAME='crm_summary_rollup_leaves' THEN
    IF TG_OP<>'INSERT' THEN
      FOR entry IN SELECT p.policy_key FROM public.crm_summary_record_policies p
        WHERE p.workspace_id=OLD.workspace_id AND p.resource_type=OLD.kind AND p.record_id=OLD.entity_id
      LOOP PERFORM public.crm_summary_shift_scope_policy(OLD.workspace_id,OLD.kind,OLD.scope_class_id,entry.policy_key,-1); END LOOP;
    END IF;
    IF TG_OP<>'DELETE' THEN
      FOR entry IN SELECT p.policy_key FROM public.crm_summary_record_policies p
        WHERE p.workspace_id=NEW.workspace_id AND p.resource_type=NEW.kind AND p.record_id=NEW.entity_id
      LOOP PERFORM public.crm_summary_shift_scope_policy(NEW.workspace_id,NEW.kind,NEW.scope_class_id,entry.policy_key,1); END LOOP;
    END IF;
  ELSE
    IF TG_OP<>'INSERT' THEN
      SELECT p.scope_class_id INTO entry FROM public.crm_summary_rollup_leaves p
      WHERE p.workspace_id=OLD.workspace_id AND p.kind=OLD.resource_type AND p.entity_id=OLD.record_id;
      IF FOUND THEN PERFORM public.crm_summary_shift_scope_policy(OLD.workspace_id,OLD.resource_type,entry.scope_class_id,OLD.policy_key,-1); END IF;
    END IF;
    IF TG_OP<>'DELETE' THEN
      SELECT p.scope_class_id INTO entry FROM public.crm_summary_rollup_leaves p
      WHERE p.workspace_id=NEW.workspace_id AND p.kind=NEW.resource_type AND p.entity_id=NEW.record_id;
      IF FOUND THEN PERFORM public.crm_summary_shift_scope_policy(NEW.workspace_id,NEW.resource_type,entry.scope_class_id,NEW.policy_key,1); END IF;
    END IF;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_scope_policy_change() FROM PUBLIC,app_user;
CREATE TRIGGER crm_summary_scope_policy_leaf_change AFTER INSERT OR UPDATE OR DELETE ON public.crm_summary_rollup_leaves
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_scope_policy_change();
CREATE TRIGGER crm_summary_scope_policy_enrollment_change AFTER INSERT OR UPDATE OR DELETE ON public.crm_summary_record_policies
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_scope_policy_change();
INSERT INTO public.crm_summary_scope_policy_usage(workspace_id,resource_type,scope_class_id,policy_key,reference_count)
  SELECT p.workspace_id,p.resource_type,l.scope_class_id,p.policy_key,count(*) FROM public.crm_summary_record_policies p
  JOIN public.crm_summary_rollup_leaves l ON l.workspace_id=p.workspace_id AND l.kind=p.resource_type AND l.entity_id=p.record_id
  GROUP BY p.workspace_id,p.resource_type,l.scope_class_id,p.policy_key;

CREATE FUNCTION public.crm_summary_admitted_scope_policy_facts(
  w uuid,actor uuid,t text,scope_ids uuid[],selected_fields text[],at_time timestamptz
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  WITH adapter AS MATERIALIZED (
    SELECT a.* FROM public.crm_summary_policy_adapters a WHERE a.workspace_id=w AND a.resource_type=t
  ), roles AS MATERIALIZED (
    SELECT r.role_key,r.starts_at,r.expires_at FROM public.application_native_role_assignments r JOIN adapter a ON a.provider_module=r.module_key
    WHERE r.workspace_id=w AND r.user_id=actor AND r.status='active'
  ), actor_roles AS MATERIALIZED (
    SELECT coalesce(array_agg(DISTINCT role_key),'{}') AS roles FROM roles
    WHERE starts_at<=at_time AND (expires_at IS NULL OR expires_at>at_time)
  ), requirements AS MATERIALIZED (
    SELECT DISTINCT p.policy_key,p.revision,p.read_rules,p.input_key,p.expected_value,p.valid_during,
      i.revision AS input_revision,i.value AS input_value,
      p.valid_during @> at_time AND (p.input_key IS NULL OR i.value=p.expected_value) AS applies
    FROM public.crm_summary_scope_policy_usage link JOIN public.crm_summary_policy_requirements p USING(workspace_id,resource_type,policy_key)
    LEFT JOIN public.crm_summary_policy_inputs i USING(workspace_id,resource_type,input_key)
    WHERE link.workspace_id=w AND link.resource_type=t AND link.scope_class_id=ANY(scope_ids) AND link.reference_count>0
  ), denied AS MATERIALIZED (
    SELECT EXISTS(SELECT 1 FROM requirements p CROSS JOIN actor_roles r JOIN LATERAL jsonb_each(p.read_rules) f ON true
      WHERE p.applies AND f.key=ANY(selected_fields) AND public.application_native_field_rule_allows(f.value,r.roles) IS NOT TRUE) AS refusal
  ), transitions AS MATERIALIZED (
    SELECT starts_at AS moment FROM roles WHERE starts_at>at_time UNION ALL SELECT expires_at FROM roles WHERE expires_at>at_time
    UNION ALL SELECT lower(valid_during) FROM requirements WHERE lower(valid_during)>at_time
    UNION ALL SELECT upper(valid_during) FROM requirements WHERE upper(valid_during)>at_time
  ) SELECT jsonb_build_object('available',selected_fields<@ARRAY(SELECT jsonb_array_elements_text(a.catalog->'fieldKeys'))
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.catalog->'fields') f WHERE f->>'key'=ANY(selected_fields)
       AND public.application_native_field_rule_allows(f->'read',r.roles) IS NOT TRUE) AND NOT (SELECT refusal FROM denied),
    'adapterRevision',a.revision,'dependencies',(SELECT coalesce(jsonb_agg(jsonb_build_array(policy_key,revision,input_key,input_revision,applies) ORDER BY policy_key),'[]') FROM requirements),
    'nextChange',(SELECT min(moment) FROM transitions))
  FROM adapter a CROSS JOIN actor_roles r
$$;
REVOKE ALL ON FUNCTION public.crm_summary_admitted_scope_policy_facts(uuid,uuid,text,uuid[],text[],timestamptz) FROM PUBLIC,app_user;

-- Pending product composition. These private routines materialize the same
-- canonical immutable evidence records in sets and perform no admission.

CREATE FUNCTION public.crm_summary_seal_canonical_receipts(w uuid, enclosures jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source_list jsonb;
BEGIN
  IF jsonb_typeof(enclosures) IS DISTINCT FROM 'array' OR jsonb_array_length(enclosures) NOT BETWEEN 1 AND 4096 THEN
    RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';
  END IF;
  -- Admission and source construction belong to the owning statement. The
  -- inputs below are the canonical immutable evidence fields, without values.
  INSERT INTO public.application_field_resources(id,workspace_id,origin,type_key,resource_id,selection,selected_version,fields,field_identity,identity)
  SELECT r.id,w,r.origin,r.type,r.record_id,r.selection,r.selected_version,r.fields,r.field_identity,r.identity
  FROM jsonb_to_recordset(enclosures) AS r(id uuid,origin jsonb,type text,record_id uuid,selection text,selected_version text,
    fields text[],field_identity text,identity text)
  ON CONFLICT DO NOTHING;

  IF EXISTS(SELECT 1 FROM jsonb_to_recordset(enclosures) AS r(id uuid,origin jsonb,type text,record_id uuid,selection text,selected_version text,
      fields text[],field_identity text,identity text)
    LEFT JOIN public.application_field_resources a ON a.workspace_id=w AND a.id=r.id
    WHERE (a.origin,a.type_key,a.resource_id,a.selection,a.selected_version,a.fields,a.field_identity,a.identity)
      IS DISTINCT FROM (r.origin,r.type,r.record_id,r.selection,r.selected_version,r.fields,r.field_identity,r.identity)) THEN
    RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';
  END IF;

  INSERT INTO public.application_field_observations(workspace_id,resource_id,version,record_version,policy_version,
    source_kind,source_id,source_version,source_scope,owner_id)
  SELECT w,r.id,r.version,r.record_version,r.policy_version,r.source_kind,r.source_id,r.source_version,r.scope,r.owner_id
  FROM jsonb_to_recordset(enclosures) AS r(id uuid,version text,record_version text,policy_version text,
    source_kind text,source_id uuid,source_version text,scope jsonb,owner_id uuid)
  ON CONFLICT DO NOTHING;

  IF EXISTS(SELECT 1 FROM jsonb_to_recordset(enclosures) AS r(id uuid,version text,record_version text,policy_version text,
      source_kind text,source_id uuid,source_version text,scope jsonb,owner_id uuid)
    LEFT JOIN public.application_field_observations a ON a.workspace_id=w AND a.resource_id=r.id AND a.version=r.version
    WHERE (a.record_version,a.policy_version,a.source_kind,a.source_id,a.source_version,a.source_scope,a.owner_id)
      IS DISTINCT FROM (r.record_version,r.policy_version,r.source_kind,r.source_id,r.source_version,r.scope,r.owner_id)) THEN
    RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';
  END IF;

  INSERT INTO public.application_field_observation_sources(workspace_id,resource_id,version,source_kind,source_id,source_version)
  SELECT w,r.id,r.version,s.kind,s.id,s.version
  FROM jsonb_to_recordset(enclosures) AS r(id uuid,version text,sources jsonb)
  CROSS JOIN LATERAL jsonb_to_recordset(r.sources) s(kind text,id uuid,version text)
  ON CONFLICT DO NOTHING;

  IF EXISTS(WITH expected AS (
    SELECT r.id AS resource_id,r.version,s.kind AS source_kind,s.id AS source_id,s.version AS source_version
    FROM jsonb_to_recordset(enclosures) AS r(id uuid,version text,sources jsonb)
    CROSS JOIN LATERAL jsonb_to_recordset(r.sources) s(kind text,id uuid,version text)
  ), actual AS (
    SELECT a.resource_id,a.version,a.source_kind,a.source_id,a.source_version
    FROM public.application_field_observation_sources a
    JOIN jsonb_to_recordset(enclosures) AS r(id uuid,version text) ON r.id=a.resource_id AND r.version=a.version
    WHERE a.workspace_id=w
  ) (SELECT * FROM actual EXCEPT SELECT * FROM expected)
    UNION ALL (SELECT * FROM expected EXCEPT SELECT * FROM actual)) THEN
    RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';
  END IF;

  SELECT jsonb_agg(r.scope||jsonb_build_object('resourceKind','application_field','resourceId',r.id,'version',r.version)
    ORDER BY r.id,r.version) INTO source_list FROM jsonb_to_recordset(enclosures) AS r(id uuid,version text,scope jsonb);
  RETURN source_list;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_seal_canonical_receipts(uuid,jsonb) FROM PUBLIC,app_user;

-- Pending production composition. Construct existing canonical source
-- identities from independently admitted, versioned policy and source facts.

CREATE FUNCTION public.crm_summary_canonical_enclosure(
  w uuid, record_kind text, record_id uuid, selection text, field_keys text[], metadata_identity text,
  record_version text, policy_version text, source_kind text, source_id uuid, source_version text,
  scope_value jsonb, owner_id uuid, sources jsonb
) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
  WITH original(origin) AS (VALUES ('{"kind":"native","moduleKey":"native"}'::jsonb)),
  field_identity AS MATERIALIZED (
    SELECT origin,public.application_field_digest(jsonb_build_object('workspaceId',w,'origin',origin,
      'typeKey',record_kind,'id',record_id,'selection',selection,'selectedVersion',NULL,'fields',field_keys,
      'fieldIdentity',metadata_identity)) AS identity FROM original
  ), resource AS MATERIALIZED (
    SELECT origin,identity,public.application_field_resource_uuid(identity) AS id FROM field_identity
  ), dependency_set AS MATERIALIZED (
    SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') AS dependencies FROM (
      SELECT DISTINCT value FROM jsonb_array_elements(sources) x(value)
    ) ordered
  ), receipt AS MATERIALIZED (
    SELECT r.*,public.application_field_digest(jsonb_build_object('resourceId',r.id,'recordVersion',record_version,
      'sourceVersion',source_version,'policyVersion',policy_version,'scope',scope_value,'sources',s.dependencies)) AS version,
      s.dependencies FROM resource r CROSS JOIN dependency_set s
  )
  SELECT jsonb_build_object('id',r.id,'origin',r.origin,'type',record_kind,'record_id',record_id,'selection',selection,
    'selected_version',NULL,'fields',field_keys,'field_identity',metadata_identity,'identity',r.identity,'version',r.version,
    'record_version',record_version,'policy_version',policy_version,'source_kind',source_kind,'source_id',source_id,
    'source_version',source_version,'scope',scope_value,'owner_id',owner_id,
    'sources',(SELECT coalesce(jsonb_agg(jsonb_build_object('kind',d->'resourceKind','id',d->'resourceId','version',d->'version')),'[]')
      FROM jsonb_array_elements(r.dependencies) d),
    'fullSources',r.dependencies,
    'source',scope_value||jsonb_build_object('resourceKind','application_field','resourceId',r.id,'version',r.version))
  FROM receipt r
$$;
REVOKE ALL ON FUNCTION public.crm_summary_canonical_enclosure(uuid,text,uuid,text,text[],text,text,text,text,uuid,text,jsonb,uuid,jsonb) FROM PUBLIC,app_user;

-- Scratch composition: publish the exact canonical configuration enclosure on
-- its existing authoritative revision write. Reads never enroll new receipts.

LOCK TABLE public.workspaces,public.application_native_crm_configuration_epochs IN SHARE ROW EXCLUSIVE MODE;
CREATE FUNCTION public.crm_summary_configuration_enclosure(w uuid,revision text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT public.crm_summary_canonical_enclosure(w,'crm_configuration',w,'read',ARRAY['config'],
    public.application_field_digest(jsonb_build_object('kind','crm-configuration-v1','fields',ARRAY['config'])),
    revision,public.application_field_digest(jsonb_build_object('kind','crm-configuration-v1','revision',revision)),
    'crm_configuration',w,revision,jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,
      'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb),NULL,'[]')
$$;
REVOKE ALL ON FUNCTION public.crm_summary_configuration_enclosure(uuid,text) FROM PUBLIC,app_user;

CREATE TABLE public.crm_summary_configuration_publications (
  workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  revision text NOT NULL,
  field_id uuid NOT NULL,
  field_version text NOT NULL,
  FOREIGN KEY(field_id,workspace_id) REFERENCES public.application_field_resources(id,workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(field_id,field_version) REFERENCES public.application_field_observations(resource_id,version) ON DELETE CASCADE
);
ALTER TABLE public.crm_summary_configuration_publications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crm_summary_configuration_publications FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_publish_configuration(w uuid,revision text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE enclosure jsonb;
BEGIN
  enclosure:=public.crm_summary_configuration_enclosure(w,revision);
  PERFORM public.crm_summary_seal_canonical_receipts(w,jsonb_build_array(enclosure));
  INSERT INTO public.crm_summary_configuration_publications AS p(workspace_id,revision,field_id,field_version)
    VALUES(w,revision,(enclosure->>'id')::uuid,enclosure->>'version')
    ON CONFLICT(workspace_id) DO UPDATE SET revision=excluded.revision,field_id=excluded.field_id,field_version=excluded.field_version
    WHERE (p.revision,p.field_id,p.field_version) IS DISTINCT FROM (excluded.revision,excluded.field_id,excluded.field_version);
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_publish_configuration(uuid,text) FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_configuration_publish() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  w uuid;
  revision text;
BEGIN
  IF TG_TABLE_NAME='workspaces' THEN
    w:=NEW.id;
    revision:=public.application_native_crm_configuration_revision(w);
  ELSE
    w:=NEW.workspace_id;
    revision:=NEW.revision::text;
  END IF;
  PERFORM public.crm_summary_publish_configuration(w,revision);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_configuration_publish() FROM PUBLIC,app_user;
CREATE TRIGGER crm_summary_configuration_publish_after_workspace_create AFTER INSERT ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_configuration_publish();
CREATE TRIGGER crm_summary_configuration_publish_after_owner_revision AFTER INSERT OR UPDATE
  ON public.application_native_crm_configuration_epochs
  FOR EACH ROW WHEN (NEW.revision IS NOT NULL) EXECUTE FUNCTION public.crm_summary_configuration_publish();

-- Retain all preexisting canonical sources. Enroll only each workspace's
-- current receipt, with the already installed immutable-shape verifier.
SELECT public.crm_summary_publish_configuration(w.id,coalesce(e.revision::text,'0')) FROM public.workspaces w
  LEFT JOIN public.application_native_crm_configuration_epochs e ON e.workspace_id=w.id;

CREATE FUNCTION public.crm_summary_field_policy_epoch(w uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_array(coalesce((SELECT e.revision FROM public.application_policy_workspace_epochs e WHERE e.workspace_id=w),0),
   (SELECT e.revision FROM public.application_policy_contract_epoch e WHERE e.singleton))
$$;
REVOKE ALL ON FUNCTION public.crm_summary_field_policy_epoch(uuid) FROM PUBLIC,app_user;
-- Typed provider publication can change independently of the entity and
-- registry, so it also versions the same fresh authority input.
CREATE TRIGGER crm_summary_provider_adapter_change AFTER INSERT OR UPDATE OR DELETE ON public.crm_summary_policy_adapters
  FOR EACH ROW EXECUTE FUNCTION public.application_policy_epoch_changed();
CREATE TRIGGER crm_summary_provider_input_change AFTER INSERT OR UPDATE OR DELETE ON public.crm_summary_policy_inputs
  FOR EACH ROW EXECUTE FUNCTION public.application_policy_epoch_changed();
CREATE TRIGGER crm_summary_provider_requirement_change AFTER INSERT OR UPDATE OR DELETE ON public.crm_summary_policy_requirements
  FOR EACH ROW EXECUTE FUNCTION public.application_policy_epoch_changed();
CREATE TRIGGER crm_summary_provider_record_change AFTER INSERT OR UPDATE OR DELETE ON public.crm_summary_record_policies
  FOR EACH ROW EXECUTE FUNCTION public.application_policy_epoch_changed();

-- Scratch storage contract for a typed summary source. Its contents describe
-- what was observed, so the function app_user invokes to read a summary must
-- acquire them itself under the same fixed authority and never accept caller
-- arguments for these fields. Durable consumer integration is separate.

CREATE TABLE public.crm_summary_source_descriptors (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  identity text NOT NULL CHECK(identity ~ '^[a-f0-9]{64}$'),
  format int NOT NULL CHECK(format=1),
  permission_mode text NOT NULL CHECK(permission_mode IN('legacy','department_v2','application','public_share')),
  original_visibility jsonb NOT NULL CHECK(jsonb_typeof(original_visibility)='object'),
  original_selector jsonb NOT NULL CHECK(jsonb_typeof(original_selector)='object'),
  selected_fields jsonb NOT NULL CHECK(jsonb_typeof(selected_fields)='object'),
  configuration_field_id uuid NOT NULL,
  configuration_field_version text NOT NULL CHECK(configuration_field_version ~ '^[a-f0-9]{64}$'),
  candidate_sets jsonb NOT NULL CHECK(jsonb_typeof(candidate_sets)='object'),
  policy_dependencies jsonb NOT NULL CHECK(jsonb_typeof(policy_dependencies)='object'),
  lineage_roots jsonb NOT NULL CHECK(jsonb_typeof(lineage_roots)='array'),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE public.crm_summary_source_descriptors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crm_summary_source_descriptors FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_source_descriptor_identity(d public.crm_summary_source_descriptors) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT public.application_field_digest(jsonb_build_object('workspaceId',d.workspace_id,'format',d.format,
    'permissionMode',d.permission_mode,'visibility',d.original_visibility,'selector',d.original_selector,
    'selectedFields',d.selected_fields,'configuration',jsonb_build_array(d.configuration_field_id,d.configuration_field_version),
    'candidateSets',d.candidate_sets,'policyDependencies',d.policy_dependencies,'lineageRoots',d.lineage_roots))
$$;
REVOKE ALL ON FUNCTION public.crm_summary_source_descriptor_identity(public.crm_summary_source_descriptors) FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_source_descriptor_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE fingerprint text;
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM public.workspaces WHERE id=OLD.workspace_id) THEN RETURN OLD; END IF;
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023'; END IF;
  fingerprint:=public.crm_summary_source_descriptor_identity(NEW);
  IF NEW.identity IS DISTINCT FROM fingerprint OR NEW.id IS DISTINCT FROM public.application_field_resource_uuid(fingerprint)
    OR NOT NEW.candidate_sets ?& ARRAY['company','deal','person'] OR NEW.candidate_sets-ARRAY['company','deal','person']<>'{}'
    OR NOT NEW.selected_fields ?& ARRAY['company','deal','person'] OR NEW.selected_fields-ARRAY['company','deal','person']<>'{}'
    OR EXISTS(SELECT 1 FROM jsonb_each(NEW.candidate_sets) field WHERE jsonb_typeof(field.value)<>'array'
      OR jsonb_array_length(field.value)>4096) THEN
    RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_source_descriptor_guard() FROM PUBLIC,app_user;
CREATE TRIGGER crm_summary_source_descriptor_guard BEFORE INSERT OR UPDATE OR DELETE ON public.crm_summary_source_descriptors
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_source_descriptor_guard();

-- Scratch domain descriptor and application-field reading adapter. This slice
-- proves the ordinary member carrier, including independent absolute revocation.

CREATE FUNCTION public.crm_summary_capture_descriptor(
  w uuid, actor uuid, context jsonb, claims jsonb, configuration public.crm_summary_configuration_publications
) RETURNS public.crm_summary_source_descriptors
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d public.crm_summary_source_descriptors;
DECLARE retained public.crm_summary_source_descriptors;
BEGIN
  d.workspace_id:=w;
  d.format:=1;
  d.permission_mode:=CASE WHEN context->>'v2'='true' THEN 'department_v2' ELSE 'legacy' END;
  d.original_visibility:=public.application_native_query_visibility();
  IF d.original_visibility IS NULL THEN RETURN NULL; END IF;
  IF d.original_visibility->>'shared'='true' THEN d.original_visibility:=jsonb_set(d.original_visibility,'{userId}','null'); END IF;
  d.original_selector:=context->'bounds';
  d.selected_fields:=jsonb_build_object('company',public.crm_summary_selected_fields('company'),
    'deal',public.crm_summary_selected_fields('deal'),'person',public.crm_summary_selected_fields('person'));
  d.configuration_field_id:=configuration.field_id;
  d.configuration_field_version:=configuration.field_version;
  d.candidate_sets:=claims->'candidates';
  d.policy_dependencies:=claims->'policyDependencies';
  d.lineage_roots:=claims->'lineageRoots';
  d.identity:=public.crm_summary_source_descriptor_identity(d);
  d.id:=public.application_field_resource_uuid(d.identity);
  INSERT INTO public.crm_summary_source_descriptors(workspace_id,id,identity,format,permission_mode,original_visibility,original_selector,
    selected_fields,configuration_field_id,configuration_field_version,candidate_sets,policy_dependencies,lineage_roots)
  VALUES(d.workspace_id,d.id,d.identity,d.format,d.permission_mode,d.original_visibility,d.original_selector,
    d.selected_fields,d.configuration_field_id,d.configuration_field_version,d.candidate_sets,d.policy_dependencies,d.lineage_roots)
  ON CONFLICT DO NOTHING;
  SELECT e.* INTO retained FROM public.crm_summary_source_descriptors e WHERE e.workspace_id=w AND e.id=d.id;
  IF retained.identity IS DISTINCT FROM d.identity OR public.crm_summary_source_descriptor_identity(retained) IS DISTINCT FROM d.identity THEN
    RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023'; END IF;
  RETURN retained;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_capture_descriptor(uuid,uuid,jsonb,jsonb,public.crm_summary_configuration_publications) FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_original_ancestry_current(w uuid,d public.crm_summary_source_descriptors) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT d.workspace_id=w AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.lineage_roots) r
    WHERE public.application_canonical_ancestry_allowed(w,'entity',(r->>0)::uuid,r->>1) IS NOT TRUE)
$$;
REVOKE ALL ON FUNCTION public.crm_summary_original_ancestry_current(uuid,public.crm_summary_source_descriptors) FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_replay_domain_descriptor(w uuid,i uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d public.crm_summary_source_descriptors;
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
DECLARE context jsonb;
DECLARE visibility jsonb;
DECLARE captured jsonb;
DECLARE config public.crm_summary_configuration_publications;
BEGIN
  SELECT q.* INTO d FROM public.crm_summary_source_descriptors q WHERE q.workspace_id=w AND q.id=i;
  IF NOT FOUND OR actor IS NULL THEN RETURN NULL; END IF;
  context:=public.crm_summary_compile_principal(w,actor);
  visibility:=public.application_native_query_visibility();
  IF context IS NULL OR visibility IS NULL
    OR d.permission_mode IS DISTINCT FROM (CASE WHEN context->>'v2'='true' THEN 'department_v2' ELSE 'legacy' END)
    OR public.application_query_scope_intersection(context->'bounds',d.original_selector) IS DISTINCT FROM d.original_selector
    OR public.application_query_set_intersection(visibility->'assistants',d.original_visibility->'assistants') IS DISTINCT FROM d.original_visibility->'assistants'
    OR d.original_visibility->>'userId' IS NOT NULL AND (d.original_visibility->>'userId'<>actor::text OR visibility->>'shared'='true')
    THEN RETURN NULL; END IF;
  SELECT p.* INTO config FROM public.crm_summary_configuration_publications p WHERE p.workspace_id=w;
  IF NOT FOUND OR (config.field_id,config.field_version) IS DISTINCT FROM (d.configuration_field_id,d.configuration_field_version)
    OR public.scope_review_state_held('application_field',config.field_id) THEN RETURN NULL; END IF;
  context:=context||jsonb_build_object('bounds',d.original_selector,'originalVisibility',d.original_visibility);
  captured:=public.crm_summary_capture_aggregate(w,actor,context,clock_timestamp(),NULL);
  IF captured->>'available' IS DISTINCT FROM 'true' OR captured->>'invalid'='true'
    OR captured#>'{sourceClaims,candidates}' IS DISTINCT FROM d.candidate_sets
    OR captured#>'{sourceClaims,policyDependencies}' IS DISTINCT FROM d.policy_dependencies
    OR captured#>'{sourceClaims,lineageRoots}' IS DISTINCT FROM d.lineage_roots THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('workspaceId',w,'userId',d.original_visibility->'userId','assistantId',NULL,
    'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb,
    'resourceKind','crm_summary_domain','resourceId',i,'version',d.identity,'held',false,'validTo',NULL,'retractedAt',NULL);
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_replay_domain_descriptor(uuid,uuid) FROM PUBLIC,app_user;

CREATE TABLE public.crm_summary_source_groups (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  descriptor_id uuid NOT NULL,
  scope jsonb NOT NULL CHECK(public.entity_derivation_envelope_valid(scope) AND scope->>'workspaceId'=workspace_id::text),
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,descriptor_id) REFERENCES public.crm_summary_source_descriptors(workspace_id,id) ON DELETE CASCADE
);
ALTER TABLE public.crm_summary_source_groups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crm_summary_source_groups FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_publish_typed_sources(d public.crm_summary_source_descriptors) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  WITH original AS MATERIALIZED (
    SELECT DISTINCT jsonb_build_object('workspaceId',d.workspace_id,'userId',r->2->0,'assistantId',r->2->1,
      'sensitivity',r->2->2,'compartments',r->2->3,'projectIds',r->2->4) AS scope
    FROM jsonb_each(d.candidate_sets) k CROSS JOIN LATERAL jsonb_array_elements(k.value) r
  ), expected AS MATERIALIZED (
    SELECT d.workspace_id AS workspace_id,public.application_field_resource_uuid(public.application_field_digest(
      jsonb_build_object('descriptor',d.id,'scope',o.scope))) AS id,d.id AS descriptor_id,o.scope FROM original o
  ), inserted AS (
    INSERT INTO public.crm_summary_source_groups(workspace_id,id,descriptor_id,scope)
    SELECT e.workspace_id,e.id,e.descriptor_id,e.scope FROM expected e ON CONFLICT DO NOTHING RETURNING *
  ), retained AS (
    SELECT * FROM inserted
    UNION ALL
    SELECT g.* FROM public.crm_summary_source_groups g JOIN expected e USING(workspace_id,id,descriptor_id,scope)
    WHERE NOT EXISTS(SELECT 1 FROM inserted n WHERE n.workspace_id=g.workspace_id AND n.id=g.id)
  )
  SELECT jsonb_build_array(jsonb_build_object('workspaceId',d.workspace_id,'userId',d.original_visibility->'userId','assistantId',NULL,
      'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb,
      'resourceKind','crm_summary_domain','resourceId',d.id,'version',d.identity))||coalesce(jsonb_agg(
    g.scope||jsonb_build_object('resourceKind','crm_summary_group','resourceId',g.id,'version',d.identity) ORDER BY g.id),'[]') FROM retained g
  HAVING count(*)=(SELECT count(*) FROM expected)
$$;
REVOKE ALL ON FUNCTION public.crm_summary_publish_typed_sources(public.crm_summary_source_descriptors) FROM PUBLIC,app_user;

CREATE FUNCTION public.read_crm_summary_typed_sources(w uuid,kinds text[],ids uuid[],versions text[])
RETURNS TABLE(ord bigint,snapshot jsonb) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF public.crm_summary_runtime_role() IS NOT TRUE OR kinds IS NULL OR ids IS NULL OR versions IS NULL
    OR cardinality(ids) NOT BETWEEN 1 AND 4096 OR cardinality(kinds)<>cardinality(ids) OR cardinality(versions)<>cardinality(ids)
    OR array_position(kinds,NULL) IS NOT NULL OR array_position(ids,NULL) IS NOT NULL OR array_position(versions,NULL) IS NOT NULL
    OR NOT kinds<@ARRAY['crm_summary_domain','crm_summary_group'] THEN RETURN; END IF;
  RETURN QUERY WITH request_rows AS MATERIALIZED (
    SELECT r.n,r.k,r.i,r.v,CASE WHEN r.k='crm_summary_domain' THEN r.i ELSE g.descriptor_id END AS descriptor,g.scope
    FROM unnest(kinds,ids,versions) WITH ORDINALITY AS r(k,i,v,n)
    LEFT JOIN public.crm_summary_source_groups g ON r.k='crm_summary_group' AND g.workspace_id=w AND g.id=r.i
  ), distinct_descriptors AS MATERIALIZED (
    SELECT DISTINCT r.descriptor FROM request_rows r JOIN public.crm_summary_source_descriptors d
      ON d.workspace_id=w AND d.id=r.descriptor AND d.identity=r.v
  ), resolved AS MATERIALIZED (
    SELECT e.descriptor,public.crm_summary_replay_domain_descriptor(w,e.descriptor) val FROM distinct_descriptors e
  ) SELECT r.n,CASE WHEN a.val IS NULL OR a.val->>'version' IS DISTINCT FROM r.v THEN NULL
    WHEN r.k='crm_summary_domain' THEN a.val
    WHEN public.workflow_evidence_envelope_visible(w,r.scope) IS TRUE THEN r.scope||jsonb_build_object(
      'resourceKind',r.k,'resourceId',r.i,'version',r.v,'held',false,'validTo',NULL,'retractedAt',NULL)
    ELSE NULL END
  FROM request_rows r LEFT JOIN resolved a USING(descriptor) ORDER BY r.n;
END $$;
REVOKE ALL ON FUNCTION public.read_crm_summary_typed_sources(uuid,text[],uuid[],text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.read_crm_summary_typed_sources(uuid,text[],uuid[],text[]) TO app_user;

-- Scratch deployment-scoped HMAC-SHA256 receipt authentication. This proves
-- which immutable input bytes were issued. It does not authorize a replay.

CREATE TABLE public.crm_summary_receipt_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pad_inner bytea NOT NULL CHECK(octet_length(pad_inner)=64),
  pad_outer bytea NOT NULL CHECK(octet_length(pad_outer)=64),
  issue_enabled boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX crm_summary_receipt_single_signer ON public.crm_summary_receipt_keys(issue_enabled) WHERE issue_enabled;
ALTER TABLE public.crm_summary_receipt_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crm_summary_receipt_keys FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_provision_receipt_key() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE seed bytea:=uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid())||decode(repeat('00',32),'hex');
DECLARE inner_pad bytea:=seed;
DECLARE outer_pad bytea:=seed;
DECLARE new_id uuid;
BEGIN
  -- Both SHA-256 pads are derived once under the private deployment owner.
  FOR i IN 0..63 LOOP
    inner_pad:=set_byte(inner_pad,i,get_byte(seed,i)#54);
    outer_pad:=set_byte(outer_pad,i,get_byte(seed,i)#92);
  END LOOP;
  UPDATE public.crm_summary_receipt_keys SET issue_enabled=false WHERE issue_enabled;
  INSERT INTO public.crm_summary_receipt_keys(pad_inner,pad_outer,issue_enabled) VALUES(inner_pad,outer_pad,true) RETURNING id INTO new_id;
  RETURN new_id;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_provision_receipt_key() FROM PUBLIC,app_user;
SELECT public.crm_summary_provision_receipt_key();

CREATE FUNCTION public.crm_summary_sign_receipt(purpose text,payload jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT jsonb_build_array(1,k.id,purpose,payload,encode(sha256(k.pad_outer||sha256(k.pad_inner||convert_to(
    jsonb_build_array('crm_summary_scope_receipt',1,k.id,purpose,payload)::text,'UTF8'))),'hex'))
  FROM public.crm_summary_receipt_keys k WHERE k.issue_enabled AND purpose IN('capture','checked','issued')
$$;
REVOKE ALL ON FUNCTION public.crm_summary_sign_receipt(text,jsonb) FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_authenticate_receipt(purpose text,packet jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE k public.crm_summary_receipt_keys;
DECLARE expected bytea;
DECLARE supplied bytea;
BEGIN
  IF jsonb_typeof(packet) IS DISTINCT FROM 'array' OR jsonb_array_length(packet)<>5
    OR packet->0 IS DISTINCT FROM '1'::jsonb OR packet->>2 IS DISTINCT FROM purpose
    OR jsonb_typeof(packet->3) IS DISTINCT FROM 'object' OR packet->>4 !~ '^[a-f0-9]{64}$' THEN RETURN NULL; END IF;
  SELECT r.* INTO k FROM public.crm_summary_receipt_keys r WHERE r.id=(packet->>1)::uuid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  expected:=sha256(k.pad_outer||sha256(k.pad_inner||convert_to(
    jsonb_build_array('crm_summary_scope_receipt',1,k.id,purpose,packet->3)::text,'UTF8')));
  supplied:=decode(packet->>4,'hex');
  -- Compare keyed digests of the MACs so byte comparison time cannot reveal
  -- a matching prefix of the actual receipt authentication tag.
  IF sha256(k.pad_inner||supplied) IS DISTINCT FROM sha256(k.pad_inner||expected) THEN RETURN NULL; END IF;
  RETURN packet->3;
EXCEPTION WHEN invalid_parameter_value OR invalid_text_representation THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_authenticate_receipt(text,jsonb) FROM PUBLIC,app_user;

-- The owning writers advance one current workspace input revision. This is a
-- fast proof of unchanged inputs, never an allow verdict or a deny on change.

LOCK TABLE public.workspaces,public.crm_summary_principal_revisions,public.crm_summary_entity_domain_versions,
  public.application_policy_workspace_epochs,public.crm_summary_configuration_publications,public.scope_resource_states IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE public.crm_summary_release_revisions (
  workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  revision uuid NOT NULL
);
ALTER TABLE public.crm_summary_release_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crm_summary_release_revisions FROM PUBLIC,app_user;
INSERT INTO public.crm_summary_release_revisions(workspace_id,revision)
  SELECT w.id,gen_random_uuid() FROM public.workspaces w;

CREATE FUNCTION public.crm_summary_release_input_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w uuid;
BEGIN
  IF TG_TABLE_NAME='workspaces' THEN w:=NEW.id;
  ELSE w:=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END; END IF;
  IF TG_TABLE_NAME='scope_resource_states' THEN
    IF NOT EXISTS(
      SELECT 1 FROM public.crm_summary_configuration_publications c
      WHERE c.workspace_id=w AND (TG_OP<>'INSERT' AND OLD.resource_kind='application_field' AND c.field_id=OLD.resource_id
        OR TG_OP<>'DELETE' AND NEW.resource_kind='application_field' AND c.field_id=NEW.resource_id)
    ) THEN RETURN NULL; END IF;
  END IF;
  IF w IS NULL OR NOT EXISTS(SELECT 1 FROM public.workspaces current_workspace WHERE current_workspace.id=w) THEN RETURN NULL; END IF;
  INSERT INTO public.crm_summary_release_revisions(workspace_id,revision)
    VALUES(w,gen_random_uuid())
    ON CONFLICT(workspace_id) DO UPDATE SET revision=gen_random_uuid();
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_release_input_changed() FROM PUBLIC,app_user;
CREATE TRIGGER crm_summary_release_workspace AFTER INSERT ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_release_input_changed();
CREATE TRIGGER crm_summary_release_principal AFTER INSERT OR UPDATE OR DELETE ON public.crm_summary_principal_revisions
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_release_input_changed();
CREATE TRIGGER crm_summary_release_domain AFTER INSERT OR UPDATE OR DELETE ON public.crm_summary_entity_domain_versions
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_release_input_changed();
CREATE TRIGGER crm_summary_release_policy AFTER INSERT OR UPDATE OR DELETE ON public.application_policy_workspace_epochs
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_release_input_changed();
CREATE TRIGGER crm_summary_release_configuration AFTER INSERT OR UPDATE OR DELETE ON public.crm_summary_configuration_publications
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_release_input_changed();

CREATE TRIGGER crm_summary_release_configuration_hold AFTER INSERT OR UPDATE OR DELETE ON public.scope_resource_states
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_release_input_changed();

CREATE FUNCTION public.crm_summary_release_revision(w uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT revision::text FROM public.crm_summary_release_revisions WHERE workspace_id=w
$$;
REVOKE ALL ON FUNCTION public.crm_summary_release_revision(uuid) FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_certificate_current(w uuid,claim jsonb,d public.crm_summary_source_descriptors) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT coalesce(claim->>'workspace'=w::text
    AND claim->>'actor'=nullif(current_setting('app.current_user_id',true),'')
    AND (claim->>'transaction')::timestamptz=transaction_timestamp()
    AND CASE WHEN public.crm_summary_release_revision(w)=claim#>>'{boundary,workspaceRevision}'
       AND (d.policy_dependencies='{}'::jsonb OR public.crm_summary_field_policy_epoch(w)=claim#>'{boundary,fieldEpoch}')
       AND (claim#>>'{boundary,nextChange}' IS NULL OR clock_timestamp()<(claim#>>'{boundary,nextChange}')::timestamptz)
      THEN true
      ELSE public.crm_summary_principal_current(w,(claim->>'actor')::uuid,claim#>'{boundary,bounds}',clock_timestamp())
        AND public.application_native_crm_configuration_revision(w)=claim#>>'{boundary,configurationVersion}'
        AND NOT public.scope_review_state_held('application_field',(claim#>>'{boundary,configurationId}')::uuid)
        AND public.crm_summary_domain_partitions_current(w,(claim->>'actor')::uuid,claim#>'{boundary,bounds}',claim#>'{boundary,domainVersions}')
        AND (public.crm_summary_field_policy_epoch(w)=claim#>'{boundary,fieldEpoch}'
          AND (claim#>>'{boundary,nextChange}' IS NULL OR clock_timestamp()<(claim#>>'{boundary,nextChange}')::timestamptz)
          OR public.crm_summary_replay_prepared_descriptor(w,d) IS NOT NULL)
      END
    AND (d.lineage_roots='[]'::jsonb OR public.crm_summary_original_ancestry_current(w,d)),false)
$$;
REVOKE ALL ON FUNCTION public.crm_summary_certificate_current(uuid,jsonb,public.crm_summary_source_descriptors) FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_certificate_source_rows(d public.crm_summary_source_descriptors,packet jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE domain_source jsonb;
DECLARE group_sources jsonb;
BEGIN
  domain_source:=jsonb_build_array(jsonb_build_object('workspaceId',d.workspace_id,'userId',d.original_visibility->'userId','assistantId',NULL,
      'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb,
      'resourceKind','crm_summary_domain','resourceId',d.id,'version',d.identity,'sourceProof',packet::text));
  IF d.candidate_sets='{"company":[],"deal":[],"person":[]}'::jsonb THEN RETURN domain_source; END IF;
  WITH grouped AS MATERIALIZED (
    SELECT DISTINCT jsonb_build_object('workspaceId',d.workspace_id,'userId',r->2->0,'assistantId',r->2->1,
      'sensitivity',r->2->2,'compartments',r->2->3,'projectIds',r->2->4) AS scope
    FROM jsonb_each(d.candidate_sets) k CROSS JOIN LATERAL jsonb_array_elements(k.value) r
  ), sources AS MATERIALIZED (
    SELECT g.scope||jsonb_build_object('resourceKind','crm_summary_group','resourceId',public.application_field_resource_uuid(
      public.application_field_digest(jsonb_build_object('descriptor',d.id,'scope',g.scope))),
      'version',d.identity,'sourceProof',packet::text) AS snapshot FROM grouped g
  ) SELECT coalesce(jsonb_agg(snapshot ORDER BY snapshot->>'resourceId'),'[]') INTO group_sources FROM sources;
  RETURN domain_source||group_sources;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_certificate_source_rows(public.crm_summary_source_descriptors,jsonb) FROM PUBLIC,app_user;

-- The database-authenticated descriptor belongs to the private host transaction.
-- This boundary makes an independent current decision without issuing another
-- certificate. A changed owner or deadline enters the exact reproof.
CREATE FUNCTION public.check_crm_summary_witness(w uuid,actor uuid,p_revision text,deadline timestamptz,field_epoch jsonb,transaction_at timestamptz,requires_lineage boolean,packet jsonb)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE claim jsonb;
DECLARE d public.crm_summary_source_descriptors;
BEGIN
  IF actor::text IS DISTINCT FROM current_setting('app.current_user_id',true)
     OR transaction_at IS DISTINCT FROM transaction_timestamp() THEN RETURN false; END IF;
  IF requires_lineage IS FALSE AND (deadline IS NULL OR clock_timestamp()<deadline)
    AND (field_epoch IS NULL OR public.crm_summary_field_policy_epoch(w)=field_epoch)
    AND EXISTS(SELECT 1 FROM public.crm_summary_release_revisions owner WHERE owner.workspace_id=w AND owner.revision=p_revision::uuid)
  THEN RETURN true; END IF;
  claim:=public.crm_summary_authenticate_receipt('issued',packet);
  IF claim IS NULL THEN RETURN false; END IF;
  d:=jsonb_populate_record(NULL::public.crm_summary_source_descriptors,claim->'descriptor');
  RETURN public.crm_summary_certificate_current(w,claim,d);
END $$;
REVOKE ALL ON FUNCTION public.check_crm_summary_witness(uuid,uuid,text,timestamptz,jsonb,timestamptz,boolean,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_crm_summary_witness(uuid,uuid,text,timestamptz,jsonb,timestamptz,boolean,jsonb) TO app_user;

LOCK TABLE public.workspaces, public.assistants, public.crm_summary_configuration_publications,
  public.scope_resource_states, public.crm_summary_entity_domain_versions,
  public.application_native_resource_owners IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.crm_summary_release_revisions
  ADD COLUMN reflector_tier integer NOT NULL DEFAULT 2,
  ADD COLUMN configuration public.crm_summary_configuration_publications,
  ADD COLUMN configuration_held boolean NOT NULL DEFAULT false,
  ADD COLUMN domain_versions jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN policy_types text[] NOT NULL DEFAULT '{}';

CREATE FUNCTION public.crm_summary_refresh_workspace_inputs(w uuid,piece text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF piece IN ('all','assistant') THEN
    UPDATE public.crm_summary_release_revisions owner SET reflector_tier=coalesce(
      (SELECT max(public.sensitivity_rank(a.clearance)) FROM public.assistants a WHERE a.workspace_id=w),2)
    WHERE owner.workspace_id=w;
  END IF;
  IF piece IN ('all','configuration') THEN
    UPDATE public.crm_summary_release_revisions owner SET
      (configuration,configuration_held)=(SELECT
        (SELECT p FROM public.crm_summary_configuration_publications p WHERE p.workspace_id=w),
        EXISTS(SELECT 1 FROM public.crm_summary_configuration_publications p
          JOIN public.scope_resource_states s ON s.workspace_id=p.workspace_id AND s.resource_id=p.field_id
          WHERE p.workspace_id=w AND s.resource_kind='application_field' AND s.review_state='held'))
    WHERE owner.workspace_id=w;
  END IF;
  IF piece IN ('all','domain') THEN
    UPDATE public.crm_summary_release_revisions owner SET domain_versions=coalesce(
      (SELECT jsonb_object_agg(v.kind,v.revision) FROM public.crm_summary_entity_domain_versions v WHERE v.workspace_id=w),'{}')
    WHERE owner.workspace_id=w;
  END IF;
  IF piece IN ('all','provider') THEN
    UPDATE public.crm_summary_release_revisions owner SET policy_types=ARRAY(
      SELECT DISTINCT o.resource_type FROM public.application_native_resource_owners o WHERE o.workspace_id=w
        AND o.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND o.resource_type IN('person','company','deal'))
    WHERE owner.workspace_id=w;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_refresh_workspace_inputs(uuid,text) FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_workspace_inputs_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w_before uuid;
DECLARE w_after uuid;
DECLARE piece text:=TG_ARGV[0];
BEGIN
  IF TG_TABLE_NAME='workspaces' THEN
    PERFORM public.crm_summary_refresh_workspace_inputs(NEW.id,piece);
    RETURN NULL;
  END IF;
  IF TG_OP<>'INSERT' THEN w_before:=OLD.workspace_id; END IF;
  IF TG_OP<>'DELETE' THEN w_after:=NEW.workspace_id; END IF;
  IF TG_TABLE_NAME='scope_resource_states' THEN
    IF TG_OP<>'INSERT' AND OLD.resource_kind<>'application_field' THEN w_before:=NULL; END IF;
    IF TG_OP<>'DELETE' AND NEW.resource_kind<>'application_field' THEN w_after:=NULL; END IF;
  ELSIF TG_TABLE_NAME='assistants' AND TG_OP='UPDATE' THEN
    IF (OLD.workspace_id,OLD.clearance) IS NOT DISTINCT FROM (NEW.workspace_id,NEW.clearance) THEN RETURN NULL; END IF;
  END IF;
  IF w_before IS NOT NULL THEN PERFORM public.crm_summary_refresh_workspace_inputs(w_before,piece); END IF;
  IF w_after IS NOT NULL AND w_after IS DISTINCT FROM w_before THEN
    PERFORM public.crm_summary_refresh_workspace_inputs(w_after,piece);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_workspace_inputs_changed() FROM PUBLIC,app_user;

CREATE TRIGGER zzz_crm_summary_workspace_inputs AFTER INSERT ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_workspace_inputs_changed('all');
CREATE TRIGGER zzz_crm_summary_reflector_inputs AFTER INSERT OR UPDATE OR DELETE ON public.assistants
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_workspace_inputs_changed('assistant');
CREATE TRIGGER zzz_crm_summary_configuration_inputs AFTER INSERT OR UPDATE OR DELETE ON public.crm_summary_configuration_publications
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_workspace_inputs_changed('configuration');
CREATE TRIGGER zzz_crm_summary_review_inputs AFTER INSERT OR UPDATE OR DELETE ON public.scope_resource_states
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_workspace_inputs_changed('configuration');
CREATE TRIGGER zzz_crm_summary_domain_inputs AFTER INSERT OR UPDATE OR DELETE ON public.crm_summary_entity_domain_versions
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_workspace_inputs_changed('domain');
CREATE TRIGGER zzz_crm_summary_policy_inputs AFTER INSERT OR UPDATE OR DELETE ON public.application_native_resource_owners
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_workspace_inputs_changed('provider');

SELECT public.crm_summary_refresh_workspace_inputs(w.workspace_id,'all') FROM public.crm_summary_release_revisions w;

CREATE FUNCTION public.crm_summary_initial_principal_stamp(w uuid,actor uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT jsonb_build_object(
    'workspaceId',w,'actorId',actor,'login',session_user,
    'role',m.role,'clearance',m.clearance,'teamScopeMode',m.team_scope_mode,'compartments',m.compartments,
    'departmentReadV2',wk.department_read_v2,'projectSharedSpaces',wk.project_shared_spaces,
    'settings',jsonb_build_object(
      'clearance',nullif(current_setting('app.agent_clearance',true),''),
      'compartments',nullif(current_setting('app.agent_compartments',true),''),
      'projects',nullif(current_setting('app.agent_project_ids',true),''),
      'assistants',nullif(current_setting('app.agent_visibility_assistants',true),''),
      'shared',current_setting('app.agent_shared_audience',true) IS NOT DISTINCT FROM 'true',
      'v2Active',current_setting('app.v2_active',true) IS NOT DISTINCT FROM 'true',
      'v2Assistant',settings.assistant,
      'v2Department',nullif(current_setting('app.v2_context_department',true),''),
      'v2Binding',nullif(current_setting('app.v2_binding',true),''),
      'v2Cap',nullif(current_setting('app.v2_cap',true),'')))
  FROM public.workspace_members m JOIN public.workspaces wk ON wk.id=m.workspace_id
  CROSS JOIN LATERAL (SELECT nullif(current_setting('app.v2_assistant_id',true),'')::uuid AS assistant OFFSET 0) settings
  WHERE m.workspace_id=w AND m.user_id=actor AND actor=nullif(current_setting('app.current_user_id',true),'')::uuid
    AND nullif(current_setting('app.application_id',true),'') IS NULL
    AND nullif(current_setting('app.public_share_root',true),'') IS NULL
    AND coalesce(nullif(current_setting('app.agent_workspace_id',true),''),w::text)=w::text
    AND coalesce(nullif(current_setting('app.agent_actor_id',true),''),actor::text)=actor::text
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.oid=session_user::regrole::oid
      AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c
        WHERE c.oid IN('public.application_query_domains'::regclass,'public.crm_pipelines'::regclass)
          AND pg_catalog.pg_has_role(r.oid,c.relowner,'USAGE')))
$$;
REVOKE ALL ON FUNCTION public.crm_summary_initial_principal_stamp(uuid,uuid) FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_capture_initial_principal(w uuid,actor uuid,at_time timestamptz,reflector_tier integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE stamp jsonb:=public.crm_summary_initial_principal_stamp(w,actor);
DECLARE settings jsonb:=stamp->'settings';
DECLARE v2 boolean:=stamp->>'departmentReadV2'='true';
DECLARE assistant uuid:=(settings->>'v2Assistant')::uuid;
DECLARE role_key text:=stamp->>'role';
DECLARE member_tier int:=public.sensitivity_rank(CASE WHEN role_key IN('owner','admin') THEN 'confidential' ELSE stamp->>'clearance' END);
DECLARE bound_tier int:=CASE WHEN v2 THEN 3 ELSE coalesce(reflector_tier,3) END;
DECLARE legacy_ceiling boolean:=settings->>'clearance' IS NOT NULL AND (NOT v2 OR settings->>'v2Active'='false' AND assistant IS NULL);
DECLARE original_labels jsonb:=coalesce((settings->>'compartments')::jsonb,'null');
DECLARE allowed_labels jsonb;
DECLARE projects jsonb:=coalesce((settings->>'projects')::jsonb,'null');
DECLARE assistants jsonb:=coalesce((settings->>'assistants')::jsonb,'null');
DECLARE binding jsonb:=coalesce((settings->>'v2Binding')::jsonb,'null');
DECLARE context_department text:=settings->>'v2Department';
DECLARE base text[];
DECLARE departments jsonb;
DECLARE project_labels jsonb;
DECLARE other_labels jsonb;
DECLARE next_change timestamptz;
DECLARE department_expiry timestamptz;
DECLARE project_expiry timestamptz;
DECLARE scope jsonb;
BEGIN
  IF stamp IS NULL OR at_time IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(assistants) NOT IN ('array','null') OR jsonb_typeof(projects) NOT IN ('array','null') THEN RETURN NULL; END IF;
  IF legacy_ceiling THEN
    bound_tier:=least(bound_tier,public.sensitivity_rank(settings->>'clearance'));
    IF bound_tier IS NULL THEN RETURN NULL; END IF;
  END IF;
  IF NOT v2 THEN
    IF role_key NOT IN('owner','admin') THEN
      IF stamp->>'teamScopeMode'='legacy' THEN
        IF stamp->'compartments'<>'null' THEN
          base:=ARRAY(SELECT jsonb_array_elements_text(stamp->'compartments'));
        END IF;
      ELSE
        base:=public.effective_member_team_compartments(actor,w);
      END IF;
    END IF;
    IF base IS NOT NULL THEN
      -- Identical labels with adjacent or overlapping grants have one frontier.
      -- Ignore timelines already admitted through fixed membership or excluded
      -- by this execution's label ceiling.
      WITH beneficiary(kind,id) AS (
        SELECT 'member',actor UNION ALL
        SELECT 'team',g.id FROM public.workspace_group_members m JOIN public.workspace_groups g ON g.id=m.group_id
        WHERE m.user_id=actor AND g.workspace_id=w AND g.status='active'
      ), windows AS (
        SELECT t.compartment_key AS label,range_agg(tstzrange(g.starts_at,g.expires_at,'[)')) AS spans
        FROM beneficiary b JOIN public.workspace_access_grants g ON g.workspace_id=w AND g.beneficiary_kind=b.kind AND g.beneficiary_id=b.id
        JOIN public.workspace_groups t ON t.id=g.target_team_id AND t.workspace_id=w AND t.status='active'
        WHERE g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>at_time)
          AND NOT coalesce(t.compartment_key=ANY(base),false)
          AND (original_labels='null' OR original_labels ? t.compartment_key)
        GROUP BY t.compartment_key
      ), active_or_future AS (
        SELECT label,span@>at_time AS active,
          CASE WHEN span@>at_time THEN upper(span) ELSE lower(span) END AS transition
        FROM windows CROSS JOIN LATERAL unnest(spans) AS span
        WHERE span@>at_time OR lower(span)>at_time
      ) SELECT ARRAY(SELECT unnest(base) UNION SELECT label FROM active_or_future WHERE active),
        (SELECT min(transition) FROM active_or_future WHERE transition<'infinity')
      INTO base,next_change;
    END IF;
    allowed_labels:=public.application_query_set_intersection(coalesce(to_jsonb(base),'null'),original_labels);
    scope:=public.application_normalize_native_query_bounds(jsonb_build_object('kind','native_legacy',
      'tier',least(member_tier,bound_tier),'compartments',allowed_labels,'projectIds',projects));
    -- The original workflow treats malformed compartment grants as denying all rows.
    IF public.agent_scope_grant_allows('app.agent_compartments','{}') IS NOT TRUE THEN RETURN NULL; END IF;
  ELSE
    allowed_labels:=CASE WHEN legacy_ceiling THEN coalesce((settings->>'compartments')::jsonb,'[]') ELSE 'null' END;
    IF jsonb_typeof(allowed_labels) NOT IN('array','null') OR jsonb_typeof(binding) NOT IN('array','null')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN allowed_labels='null' THEN '[]' ELSE allowed_labels END) i WHERE jsonb_typeof(i)<>'string')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN binding='null' THEN '[]' ELSE binding END) i WHERE jsonb_typeof(i)<>'string') THEN RETURN NULL; END IF;
    bound_tier:=least(bound_tier,CASE WHEN settings->>'v2Cap' IS NULL THEN 3 ELSE coalesce(public.sensitivity_rank(settings->>'v2Cap'),0) END);
    IF assistant IS NOT NULL THEN
      member_tier:=least(member_tier,coalesce((SELECT public.sensitivity_rank(a.clearance) FROM public.assistants a WHERE a.id=assistant AND a.workspace_id=w),0));
    END IF;
    SELECT coalesce(jsonb_object_agg(e.department_id,least(public.sensitivity_rank(e.clearance),bound_tier,
             CASE WHEN assistant IS NULL THEN 3 ELSE public.sensitivity_rank(a.clearance) END)),'{}'),
           min(least(nullif(e.expires_at,'infinity'),nullif(a.expires_at,'infinity')))
      INTO departments,department_expiry
    FROM public.department_edges e LEFT JOIN public.department_edges a ON a.department_id=e.department_id AND a.assistant_id=assistant
      AND (a.expires_at IS NULL OR a.expires_at>at_time)
    WHERE e.workspace_id=w AND e.user_id=actor AND (e.expires_at IS NULL OR e.expires_at>at_time)
      AND (assistant IS NULL OR a.id IS NOT NULL) AND bound_tier>0
      AND (binding='null' OR binding ? e.department_id::text)
      AND (allowed_labels='null' OR allowed_labels ? ('team:'||e.department_id::text));
    project_labels:='[]';
    IF stamp->>'projectSharedSpaces'='true' THEN
      SELECT coalesce(jsonb_agg(s.project_id::text ORDER BY s.project_id),'[]'),
             min(least(CASE WHEN role_key<>'owner' THEN nullif(h.expires_at,'infinity') END,nullif(a.expires_at,'infinity')))
        INTO project_labels,project_expiry
      FROM public.project_shared_scopes s
      LEFT JOIN public.project_shared_members h ON h.project_id=s.project_id AND h.user_id=actor AND (h.expires_at IS NULL OR h.expires_at>at_time)
      LEFT JOIN public.project_shared_members a ON a.project_id=s.project_id AND a.assistant_id=assistant AND (a.expires_at IS NULL OR a.expires_at>at_time)
      WHERE s.workspace_id=w AND s.status='active' AND (role_key='owner' OR h.id IS NOT NULL)
        AND (assistant IS NULL OR a.id IS NOT NULL) AND (binding='null' OR binding ? s.project_id::text)
        AND (allowed_labels='null' OR allowed_labels ? ('project:'||s.project_id::text));
    END IF;
    other_labels:='null';
    IF allowed_labels<>'null' THEN
      SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO other_labels FROM (
        SELECT DISTINCT value FROM jsonb_array_elements(allowed_labels)
        WHERE value#>>'{}' NOT LIKE 'team:%' AND value#>>'{}' NOT LIKE 'project:%'
      ) labels;
    END IF;
    scope:=jsonb_build_object('kind','native_department_v2','tier',least(member_tier,bound_tier),
      'departments',departments,'contextDepartment',context_department,'projectLabels',project_labels,'otherLabels',other_labels,'projectIds',projects);
    next_change:=least(department_expiry,project_expiry);
  END IF;
  IF public.application_query_scope_valid(scope) IS NOT TRUE THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('mode',CASE WHEN v2 THEN 'department_v2' ELSE 'legacy' END,
    'nativeBounds',scope,'visibility',jsonb_build_object('userId',CASE WHEN settings->>'shared'='false' THEN actor END,'assistants',assistants),
    'principalStamp',stamp,'nextChange',next_change);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_capture_initial_principal(uuid,uuid,timestamptz,integer) FROM PUBLIC,app_user;

CREATE TYPE public.crm_summary_member_facts AS (
  role text,
  clearance text,
  team_mode text,
  compartments text[],
  department_v2 boolean,
  project_shared boolean
);

CREATE FUNCTION public.crm_summary_read_member_facts(w uuid,actor uuid) RETURNS public.crm_summary_member_facts
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
RETURN (
  SELECT ROW(m.role,m.clearance,m.team_scope_mode,m.compartments,wk.department_read_v2,wk.project_shared_spaces)::public.crm_summary_member_facts
  FROM public.workspace_members m JOIN public.workspaces wk ON wk.id=m.workspace_id
  WHERE m.workspace_id=w AND m.user_id=actor
    AND actor=nullif(current_setting('app.current_user_id',true),'')::uuid
    AND nullif(current_setting('app.application_id',true),'') IS NULL
    AND nullif(current_setting('app.public_share_root',true),'') IS NULL
    AND coalesce(nullif(current_setting('app.agent_workspace_id',true),''),w::text)=w::text
    AND coalesce(nullif(current_setting('app.agent_actor_id',true),''),actor::text)=actor::text
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.oid=session_user::regrole::oid
      AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c
        WHERE c.oid IN('public.application_query_domains'::regclass,'public.crm_pipelines'::regclass)
          AND pg_catalog.pg_has_role(r.oid,c.relowner,'USAGE')))
);
REVOKE ALL ON FUNCTION public.crm_summary_read_member_facts(uuid,uuid) FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_http_member_scope(w uuid,actor uuid,at_time timestamptz,reflector_tier integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE member public.crm_summary_member_facts;
DECLARE visibility jsonb;
DECLARE principal jsonb;
DECLARE tier integer;
DECLARE departments jsonb;
DECLARE projects jsonb:='[]';
DECLARE departments_change timestamptz;
DECLARE projects_change timestamptz;
DECLARE native_bounds jsonb;
BEGIN
  member:=public.crm_summary_read_member_facts(w,actor);
  IF member.role IS NULL THEN RETURN NULL; END IF;
  -- This carrier represents the established whole-workspace principal. A
  -- narrower inherited host context uses the exact general compiler.
  IF nullif(current_setting('app.agent_clearance',true),'') IS NOT NULL
    OR nullif(current_setting('app.v2_active',true),'') IS NOT NULL
    OR nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL THEN
    RETURN public.crm_summary_capture_initial_principal(w,actor,at_time,reflector_tier);
  END IF;
  IF member.role IN ('owner','admin') THEN tier:=3;
  ELSE tier:=public.sensitivity_rank(member.clearance); END IF;
  visibility:=jsonb_build_object('userId',actor,'assistants',NULL);
  principal:=jsonb_build_object('workspaceId',w);
  IF member.department_v2 THEN
    SELECT coalesce(jsonb_object_agg(e.department_id,least(public.sensitivity_rank(e.clearance),3)),'{}'),
           min(nullif(e.expires_at,'infinity'))
      INTO departments,departments_change
    FROM public.department_edges e
    WHERE e.workspace_id=w AND e.user_id=actor AND (e.expires_at IS NULL OR e.expires_at>at_time);
    IF member.project_shared THEN
      SELECT coalesce(jsonb_agg(s.project_id::text ORDER BY s.project_id),'[]'),
             min(CASE WHEN member.role<>'owner' THEN nullif(h.expires_at,'infinity') END)
        INTO projects,projects_change
      FROM public.project_shared_scopes s
      LEFT JOIN public.project_shared_members h ON h.project_id=s.project_id AND h.user_id=actor
        AND (h.expires_at IS NULL OR h.expires_at>at_time)
      WHERE s.workspace_id=w AND s.status='active' AND (member.role='owner' OR h.id IS NOT NULL);
    END IF;
    native_bounds:=jsonb_build_object('kind','native_department_v2','tier',tier,
      'departments',departments,'contextDepartment',NULL,'projectLabels',projects,'otherLabels',NULL,'projectIds',NULL);
    RETURN jsonb_build_object('mode','department_v2','nativeBounds',native_bounds,'visibility',visibility,'principalStamp',principal,
      'nextChange',least(departments_change,projects_change));
  END IF;
  IF member.role NOT IN ('owner','admin')
    AND (member.team_mode IS DISTINCT FROM 'legacy' OR member.compartments IS NOT NULL) THEN
    -- The same typed source compiler owns legacy group data, temporal grants
    -- and finite intersections for all entry points.
    RETURN public.crm_summary_capture_initial_principal(w,actor,at_time,reflector_tier);
  END IF;
  RETURN jsonb_build_object('mode','legacy','nativeBounds',jsonb_build_object('kind','native_department_v2',
    'tier',least(tier,reflector_tier),'departments',NULL,'contextDepartment',NULL,'projectLabels','[]'::jsonb,
    'otherLabels',NULL,'projectIds',NULL),'visibility',visibility,'principalStamp',principal,'nextChange',NULL);
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_http_member_scope(uuid,uuid,timestamptz,integer) FROM PUBLIC,app_user;

-- Fused receipt reproof reloads the current legacy reflector in addition to
-- current member grant scope. A lowered reflector refuses either release.
CREATE FUNCTION public.crm_summary_http_scope_covers(w uuid,actor uuid,original jsonb,at_time timestamptz) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE current_tier integer;
DECLARE live jsonb;
BEGIN
  SELECT r.reflector_tier INTO current_tier FROM public.crm_summary_release_revisions r WHERE r.workspace_id=w;
  IF NOT FOUND THEN RETURN false; END IF;
  live:=public.crm_summary_http_member_scope(w,actor,at_time,current_tier);
  RETURN coalesce(live->>'mode'=original->>'mode'
    AND live->'visibility'=original->'visibility'
    AND public.application_query_scope_intersection(live->'nativeBounds',original->'nativeBounds')=original->'nativeBounds',false);
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_http_scope_covers(uuid,uuid,jsonb,timestamptz) FROM PUBLIC,app_user;

-- Scope and provider membership apply to the whole domain. Business and lineage
-- evaluation consumes exactly that admitted set, including a proven empty set.

CREATE FUNCTION public.crm_summary_capture_visible_rollups(w uuid,scope_ids uuid[],pipeline_filter text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
WITH visible_scopes AS MATERIALIZED (SELECT id FROM unnest(scope_ids) s(id)
), original_rollups AS MATERIALIZED (
 SELECT c.kind,c.scope_class_id,c.pipeline_id,c.stage_id,c.legacy_open,c.currency,c.active_rows,c.invalid_rows,
   c.valued_rows,c.amount_total,c.orphaned_rows
 FROM public.crm_summary_rollups c JOIN visible_scopes s ON s.id=c.scope_class_id WHERE c.workspace_id=w
), configurations AS MATERIALIZED (
 SELECT r.pipeline_id,r.stage_id,s.category,
   p.id IS NOT NULL AND (r.stage_id IS NULL OR s.id IS NOT NULL) AS valid
 FROM (SELECT DISTINCT c.pipeline_id,c.stage_id FROM original_rollups c WHERE c.kind='deal'
   AND (c.pipeline_id IS NOT NULL OR c.stage_id IS NOT NULL)) r
 LEFT JOIN public.crm_pipelines p ON p.workspace_id=w AND p.id=r.pipeline_id AND p.archived_at IS NULL
 LEFT JOIN public.crm_pipeline_stages s ON s.workspace_id=w AND s.pipeline_id=p.id AND s.id=r.stage_id AND s.archived_at IS NULL
), selected AS MATERIALIZED (
 SELECT c.*,CASE WHEN c.stage_id IS NULL THEN c.legacy_open ELSE r.category='open' END AS is_open
 FROM original_rollups c LEFT JOIN configurations r ON r.stage_id=c.stage_id AND r.pipeline_id=c.pipeline_id
 WHERE c.kind<>'deal' OR pipeline_filter IS NULL OR c.pipeline_id::text=pipeline_filter
), times AS MATERIALIZED (
 SELECT a.metric,coalesce(sum(a.contributing_rows),0) AS rows
 FROM public.crm_summary_attention_rollups a JOIN visible_scopes s ON s.id=a.scope_class_id
 LEFT JOIN configurations c ON c.pipeline_id=a.pipeline_id AND c.stage_id=a.stage_id
 WHERE a.workspace_id=w AND (pipeline_filter IS NULL OR a.pipeline_id::text=pipeline_filter)
   AND (CASE WHEN a.stage_id IS NULL THEN a.legacy_open ELSE c.category='open' END)
   AND (a.metric='close' AND a.coordinate<(CURRENT_DATE-DATE '1970-01-01')::bigint
     OR a.metric='stale' AND a.coordinate<(extract(epoch FROM (now()-interval '30 days'))*1000000)::bigint)
 GROUP BY a.metric
), ancestry_ids AS MATERIALIZED (
 SELECT d.resource_id AS id FROM public.scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='entity'
 UNION SELECT e.superseded_by FROM public.entities e WHERE e.workspace_id=w AND e.superseded_by IS NOT NULL
), required_ancestry AS MATERIALIZED (
 SELECT p.entity_id,p.record_version FROM ancestry_ids a JOIN public.crm_summary_rollup_leaves p ON p.workspace_id=w AND p.entity_id=a.id
 JOIN visible_scopes s ON p.scope_class_id=s.id
), source_roots AS MATERIALIZED (
 SELECT g.kind,g.scope_class_id,g.last_changed,jsonb_build_array(c.user_id,c.assistant_id,c.sensitivity,c.compartments,c.project_ids) AS scope
 FROM public.crm_summary_scope_partition_versions g JOIN (SELECT DISTINCT kind,scope_class_id FROM original_rollups) p USING(kind,scope_class_id)
 JOIN public.crm_summary_scope_classes c ON c.workspace_id=g.workspace_id AND c.id=g.scope_class_id
 WHERE g.workspace_id=w
), source_sets AS MATERIALIZED (
 SELECT r.kind,jsonb_agg(jsonb_build_array(r.scope_class_id,r.last_changed,r.scope) ORDER BY r.scope_class_id) AS records
 FROM source_roots r GROUP BY r.kind
), unavailable AS MATERIALIZED (
 SELECT EXISTS(SELECT 1 FROM configurations c WHERE NOT c.valid)
   OR EXISTS(SELECT 1 FROM public.crm_summary_company_references r JOIN visible_scopes s ON s.id=r.scope_class_id
     WHERE r.workspace_id=w AND NOT EXISTS(SELECT 1 FROM public.crm_summary_rollup_leaves c
       JOIN visible_scopes n ON n.id=c.scope_class_id WHERE c.workspace_id=w AND c.kind='company' AND c.entity_id=r.company_id))
   OR EXISTS(SELECT 1 FROM required_ancestry a WHERE public.application_canonical_ancestry_allowed(w,'entity',a.entity_id,a.record_version::text) IS NOT TRUE)
   AS denied
)
SELECT jsonb_build_object('available',NOT (SELECT denied FROM unavailable),
 'invalid',EXISTS(SELECT 1 FROM original_rollups p WHERE p.invalid_rows>0),
 'summary',jsonb_build_object('rollups',coalesce((SELECT jsonb_agg(jsonb_build_array(
    p.kind,p.stage_id,p.currency,p.active_rows,p.valued_rows,p.amount_total::text,p.orphaned_rows,p.is_open
  )) FROM selected p),'[]'),
  'overdue',coalesce((SELECT t.rows FROM times t WHERE t.metric='close'),0),
  'stale',coalesce((SELECT t.rows FROM times t WHERE t.metric='stale'),0)),
 'candidates',jsonb_build_object('company','[]'::jsonb,'deal','[]'::jsonb,'person','[]'::jsonb)
    ||(SELECT coalesce(jsonb_object_agg(s.kind,s.records),'{}'::jsonb) FROM source_sets s),
 'lineageRoots',(SELECT coalesce(jsonb_agg(jsonb_build_array(a.entity_id,a.record_version) ORDER BY a.entity_id),'[]'::jsonb) FROM required_ancestry a))

$$;
REVOKE ALL ON FUNCTION public.crm_summary_capture_visible_rollups(uuid,uuid[],text) FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_capture_aggregate(w uuid,actor uuid,bounds jsonb,boundary_time timestamptz,pipeline_filter text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE provider record;
DECLARE evidence jsonb;
DECLARE selected uuid[];
DECLARE resolution jsonb;
DECLARE dependencies jsonb:='{}';
DECLARE time_frontier timestamptz;
DECLARE inputs public.crm_summary_release_revisions;
BEGIN
  SELECT ARRAY(
    SELECT c.id FROM public.crm_summary_scope_classes c
    WHERE c.workspace_id=w
      AND EXISTS(SELECT 1 FROM public.crm_summary_rollups p WHERE p.workspace_id=w AND p.scope_class_id=c.id)
      AND public.crm_summary_scope_partition_admitted(w,actor,bounds,c)
  ) INTO selected;
  SELECT p.* INTO inputs FROM public.crm_summary_release_revisions p WHERE p.workspace_id=w;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF cardinality(inputs.policy_types)>0 THEN
    FOR provider IN SELECT o.resource_type,a.catalog->'scope' AS catalog_scope
      FROM public.application_native_resource_owners o
      LEFT JOIN public.crm_summary_policy_adapters a ON a.workspace_id=w AND a.resource_type=o.resource_type
      WHERE o.workspace_id=w AND o.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND o.resource_type=ANY(inputs.policy_types)
    LOOP
      evidence:=public.crm_summary_admitted_scope_policy_facts(w,actor,provider.resource_type,selected,
        public.crm_summary_selected_fields(provider.resource_type),boundary_time);
      IF evidence->>'available' IS DISTINCT FROM 'true'
        OR public.workflow_evidence_envelope_visible(w,provider.catalog_scope) IS NOT TRUE THEN RETURN NULL; END IF;
      dependencies:=dependencies||jsonb_build_object(provider.resource_type,evidence-'nextChange');
      time_frontier:=least(time_frontier,(evidence->>'nextChange')::timestamptz);
    END LOOP;
  END IF;
  IF cardinality(selected)>0 THEN
    resolution:=public.crm_summary_capture_visible_rollups(w,selected,pipeline_filter);
  ELSE
    resolution:='{"available":true,"invalid":false,"candidates":{"company":[],"deal":[],"person":[]},"lineageRoots":[],"summary":{"totals":{"deals":0,"contacts":0,"companies":0},"attention":{"overdue":0,"stale":0,"noAmount":0,"orphaned":0},"stages":[]}}';
  END IF;
  RETURN (resolution - ARRAY['candidates','lineageRoots']) || jsonb_build_object(
    'configurationVersion',(inputs.configuration).revision,'domainVersions',inputs.domain_versions,'policyDeadline',time_frontier,
    'sourceClaims',jsonb_build_object('candidates',resolution->'candidates','policyDependencies',dependencies,'lineageRoots',resolution->'lineageRoots'));
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_capture_aggregate(uuid,uuid,jsonb,timestamptz,text) FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_prepare_typed_descriptor(
  w uuid, context jsonb, claims jsonb, configuration public.crm_summary_configuration_publications, reflector boolean
) RETURNS public.crm_summary_source_descriptors
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d public.crm_summary_source_descriptors;
BEGIN
  d.workspace_id:=w;
  d.format:=1;
  d.permission_mode:=context->>'mode';
  d.original_visibility:=context->'visibility';
  IF d.original_visibility IS NULL THEN RETURN NULL; END IF;
  d.original_selector:=context->'nativeBounds';
  IF reflector THEN d.original_visibility:=d.original_visibility||'{"workspaceReflector":true}'; END IF;
  d.selected_fields:='{"company":["archivedAt"],"deal":["amount","archivedAt","closeDate","currencyCode","pipelineId","pipelineStageId","stage","updatedAt"],"person":["archivedAt","companyId"]}';
  d.configuration_field_id:=configuration.field_id;
  d.configuration_field_version:=configuration.field_version;
  d.candidate_sets:=claims->'candidates';
  d.policy_dependencies:=claims->'policyDependencies';
  d.lineage_roots:=claims->'lineageRoots';
  d.identity:=public.crm_summary_source_descriptor_identity(d);
  d.id:=public.application_field_resource_uuid(d.identity);
  RETURN d;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_prepare_typed_descriptor(uuid,jsonb,jsonb,public.crm_summary_configuration_publications,boolean) FROM PUBLIC,app_user;

DO $$
BEGIN
  IF EXISTS(
    SELECT 1 FROM (VALUES 
      ('company',ARRAY['archivedAt']),('person',ARRAY['archivedAt','companyId']),
      ('deal',ARRAY['amount','archivedAt','closeDate','currencyCode','pipelineId','pipelineStageId','stage','updatedAt'])
    ) expected(kind,fields) WHERE public.crm_summary_selected_fields(expected.kind) IS DISTINCT FROM expected.fields
  ) THEN RAISE EXCEPTION 'crm_summary_selected_fields_changed'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.crm_summary_replay_prepared_descriptor(w uuid,d public.crm_summary_source_descriptors) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
DECLARE context jsonb;
DECLARE visibility jsonb;
DECLARE captured jsonb;
DECLARE config public.crm_summary_configuration_publications;
BEGIN
  IF d.workspace_id IS DISTINCT FROM w OR d.id IS NULL OR actor IS NULL
    OR public.crm_summary_source_descriptor_identity(d) IS DISTINCT FROM d.identity THEN RETURN NULL; END IF;
  IF d.original_visibility->>'workspaceReflector'='true' THEN
    context:=public.crm_summary_http_member_scope(w,actor,clock_timestamp(),
      (SELECT p.reflector_tier FROM public.crm_summary_release_revisions p WHERE p.workspace_id=w));
  ELSE
    context:=public.crm_summary_capture_principal(w,actor,clock_timestamp());
  END IF;
  visibility:=context->'visibility';
  IF context IS NULL OR visibility IS NULL
    OR d.permission_mode IS DISTINCT FROM context->>'mode'
    OR public.application_query_scope_intersection(context->'nativeBounds',d.original_selector) IS DISTINCT FROM d.original_selector
    OR public.application_query_set_intersection(visibility->'assistants',d.original_visibility->'assistants') IS DISTINCT FROM d.original_visibility->'assistants'
    OR d.original_visibility->>'userId' IS NOT NULL AND (d.original_visibility->>'userId'<>actor::text OR visibility->>'shared'='true')
    THEN RETURN NULL; END IF;
  SELECT p.* INTO config FROM public.crm_summary_configuration_publications p WHERE p.workspace_id=w;
  IF NOT FOUND OR (config.field_id,config.field_version) IS DISTINCT FROM (d.configuration_field_id,d.configuration_field_version)
    OR public.scope_review_state_held('application_field',config.field_id) THEN RETURN NULL; END IF;
  context:=context||jsonb_build_object('nativeBounds',d.original_selector,'visibility',d.original_visibility);
  captured:=public.crm_summary_capture_aggregate(w,actor,context,clock_timestamp(),NULL);
  IF captured->>'available' IS DISTINCT FROM 'true' OR captured->>'invalid'='true'
    OR captured#>'{sourceClaims,candidates}' IS DISTINCT FROM d.candidate_sets
    OR captured#>'{sourceClaims,policyDependencies}' IS DISTINCT FROM d.policy_dependencies
    OR captured#>'{sourceClaims,lineageRoots}' IS DISTINCT FROM d.lineage_roots THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('workspaceId',w,'userId',d.original_visibility->'userId','assistantId',NULL,
    'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb,
    'resourceKind','crm_summary_domain','resourceId',d.id,'version',d.identity,'held',false,'validTo',NULL,'retractedAt',NULL);
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_replay_prepared_descriptor(uuid,public.crm_summary_source_descriptors) FROM PUBLIC,app_user;
CREATE OR REPLACE FUNCTION public.crm_summary_certificate_current(w uuid,claim jsonb,d public.crm_summary_source_descriptors) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT coalesce(claim->>'workspace'=w::text
    AND claim->>'actor'=nullif(current_setting('app.current_user_id',true),'')
    AND (claim->>'transaction')::timestamptz=transaction_timestamp()
    AND CASE WHEN public.crm_summary_release_revision(w)=claim#>>'{boundary,workspaceRevision}'
       AND (d.policy_dependencies='{}'::jsonb OR public.crm_summary_field_policy_epoch(w)=claim#>'{boundary,fieldEpoch}')
       AND (claim#>>'{boundary,nextChange}' IS NULL OR clock_timestamp()<(claim#>>'{boundary,nextChange}')::timestamptz)
      THEN true
      ELSE CASE WHEN d.original_visibility->>'workspaceReflector'='true'
          THEN public.crm_summary_http_scope_covers(w,(claim->>'actor')::uuid,claim#>'{boundary,bounds}',clock_timestamp())
          ELSE public.crm_summary_principal_current(w,(claim->>'actor')::uuid,claim#>'{boundary,bounds}',clock_timestamp()) END
        AND public.application_native_crm_configuration_revision(w)=claim#>>'{boundary,configurationVersion}'
        AND NOT public.scope_review_state_held('application_field',(claim#>>'{boundary,configurationId}')::uuid)
        AND public.crm_summary_domain_partitions_current(w,(claim->>'actor')::uuid,claim#>'{boundary,bounds}',claim#>'{boundary,domainVersions}')
        AND (public.crm_summary_field_policy_epoch(w)=claim#>'{boundary,fieldEpoch}'
          AND (claim#>>'{boundary,nextChange}' IS NULL OR clock_timestamp()<(claim#>>'{boundary,nextChange}')::timestamptz)
          OR public.crm_summary_replay_prepared_descriptor(w,d) IS NOT NULL)
      END
    AND (d.lineage_roots='[]'::jsonb OR public.crm_summary_original_ancestry_current(w,d)),false)
$$;
REVOKE ALL ON FUNCTION public.crm_summary_certificate_current(uuid,jsonb,public.crm_summary_source_descriptors) FROM PUBLIC,app_user;

CREATE FUNCTION public.read_crm_summary_certificate_sources(w uuid,kinds text[],ids uuid[],versions text[],packets jsonb[])
RETURNS TABLE(ord bigint,snapshot jsonb) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
  IF public.crm_summary_principal_stamp(w,actor) IS NULL OR kinds IS NULL OR ids IS NULL OR versions IS NULL OR packets IS NULL
    OR cardinality(ids) NOT BETWEEN 1 AND 4096 OR cardinality(kinds)<>cardinality(ids) OR cardinality(versions)<>cardinality(ids)
    OR cardinality(packets)<>cardinality(ids) OR array_position(kinds,NULL) IS NOT NULL OR array_position(ids,NULL) IS NOT NULL
    OR array_position(versions,NULL) IS NOT NULL OR NOT kinds<@ARRAY['crm_summary_domain','crm_summary_group'] THEN RETURN; END IF;
  RETURN QUERY WITH request_rows AS MATERIALIZED (
    SELECT * FROM unnest(kinds,ids,versions,packets) WITH ORDINALITY AS r(k,i,v,packet,n)
  ), packet_set AS MATERIALIZED (SELECT DISTINCT packet FROM request_rows r WHERE r.packet IS NOT NULL),
  opened AS MATERIALIZED (
    SELECT p.packet,public.crm_summary_authenticate_receipt('issued',p.packet) AS claim FROM packet_set p
  ), external_as_original AS MATERIALIZED (
    SELECT o.packet,jsonb_populate_record(NULL::public.crm_summary_source_descriptors,o.claim->'descriptor') AS d
    FROM opened o WHERE o.claim IS NOT NULL
  ), retained_as_original AS MATERIALIZED (
    SELECT DISTINCT d AS d FROM request_rows r JOIN public.crm_summary_source_descriptors d ON d.workspace_id=w AND d.identity=r.v
    WHERE r.packet IS NULL AND (r.k='crm_summary_domain' AND r.i=d.id OR r.k='crm_summary_group'
      AND EXISTS(SELECT 1 FROM public.crm_summary_source_groups g WHERE g.workspace_id=w AND g.descriptor_id=d.id AND g.id=r.i))
  ), original AS MATERIALIZED (SELECT e.packet,e.d FROM external_as_original e
    UNION ALL SELECT NULL,r.d FROM retained_as_original r),
  replayed AS MATERIALIZED (
    SELECT o.packet,o.d,public.crm_summary_replay_prepared_descriptor(w,o.d) AS current FROM original o
  ), sources AS MATERIALIZED (
    SELECT a.packet,ss.value AS source FROM replayed a CROSS JOIN LATERAL
     jsonb_array_elements(public.crm_summary_certificate_source_rows(a.d,a.packet)) ss
    WHERE a.current IS NOT NULL
  ) SELECT r.n,CASE WHEN s.source IS NOT NULL THEN s.source-'sourceProof'||jsonb_build_object('held',false,'validTo',NULL,'retractedAt',NULL) END
  FROM request_rows r LEFT JOIN sources s ON s.packet IS NOT DISTINCT FROM r.packet AND s.source->>'resourceKind'=r.k
    AND (s.source->>'resourceId')::uuid=r.i AND s.source->>'version'=r.v ORDER BY r.n;
END $$;
REVOKE ALL ON FUNCTION public.read_crm_summary_certificate_sources(uuid,text[],uuid[],text[],jsonb[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.read_crm_summary_certificate_sources(uuid,text[],uuid[],text[],jsonb[]) TO app_user;

CREATE FUNCTION public.retain_crm_summary_certificate(w uuid,packet jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
DECLARE claim jsonb;
DECLARE d public.crm_summary_source_descriptors;
DECLARE retained public.crm_summary_source_descriptors;
BEGIN
  IF public.crm_summary_principal_stamp(w,actor) IS NULL THEN RETURN NULL; END IF;
  claim:=public.crm_summary_authenticate_receipt('issued',packet);
  IF claim IS NULL THEN RETURN NULL; END IF;
  d:=jsonb_populate_record(NULL::public.crm_summary_source_descriptors,claim->'descriptor');
  IF public.crm_summary_replay_prepared_descriptor(w,d) IS NULL THEN RETURN NULL; END IF;
  INSERT INTO public.crm_summary_source_descriptors(workspace_id,id,identity,format,permission_mode,original_visibility,original_selector,
    selected_fields,configuration_field_id,configuration_field_version,candidate_sets,policy_dependencies,lineage_roots)
  VALUES(d.workspace_id,d.id,d.identity,d.format,d.permission_mode,d.original_visibility,d.original_selector,
    d.selected_fields,d.configuration_field_id,d.configuration_field_version,d.candidate_sets,d.policy_dependencies,d.lineage_roots)
  ON CONFLICT DO NOTHING;
  SELECT q.* INTO retained FROM public.crm_summary_source_descriptors q WHERE q.workspace_id=w AND q.id=d.id;
  IF NOT FOUND OR retained.identity IS DISTINCT FROM d.identity THEN RETURN NULL; END IF;
  RETURN public.crm_summary_publish_typed_sources(retained);
END $$;
REVOKE ALL ON FUNCTION public.retain_crm_summary_certificate(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retain_crm_summary_certificate(uuid,jsonb) TO app_user;

CREATE OR REPLACE FUNCTION public.crm_summary_read_member_facts(w uuid,actor uuid) RETURNS public.crm_summary_member_facts
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
RETURN (
  SELECT ROW(m.role,m.clearance,m.team_scope_mode,m.compartments,wk.department_read_v2,wk.project_shared_spaces)::public.crm_summary_member_facts
  FROM public.workspace_members m JOIN public.workspaces wk ON wk.id=m.workspace_id
  WHERE m.workspace_id=w AND m.user_id=actor
    AND nullif(current_setting('app.application_id',true),'') IS NULL
    AND nullif(current_setting('app.public_share_root',true),'') IS NULL
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.oid=session_user::regrole::oid
      AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c
        WHERE c.oid IN('public.application_query_domains'::regclass,'public.crm_pipelines'::regclass)
          AND pg_catalog.pg_has_role(r.oid,c.relowner,'USAGE')))
);
REVOKE ALL ON FUNCTION public.crm_summary_read_member_facts(uuid,uuid) FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_sign_issued_receipt(payload jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
RETURN (
  SELECT jsonb_build_array(1,k.id,'issued',payload,encode(sha256(k.pad_outer||sha256(k.pad_inner||convert_to(
    jsonb_build_array('crm_summary_scope_receipt',1,k.id,'issued',payload)::text,'UTF8'))),'hex'))
  FROM public.crm_summary_receipt_keys k WHERE k.issue_enabled
);
REVOKE ALL ON FUNCTION public.crm_summary_sign_issued_receipt(jsonb) FROM PUBLIC,app_user;

-- Isolated receiving proof for actual CRM rows, stage authority and the two
-- version/current-authority rechecks. Final route and aggregate source receipt
-- integration are separate open production work.

CREATE FUNCTION public.read_crm_summary_sealed(w uuid, pipeline_filter text,reflector boolean) RETURNS TABLE(membership boolean,summary jsonb,sources jsonb,
  revision text,deadline text,field_epoch text,transaction_at text,requires_lineage boolean,packet text,
  configuration_id uuid,configuration_version text,source_id uuid,source_identity text,source_user_id text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
  observed_at timestamptz:=clock_timestamp();
  bounds jsonb;
  captured jsonb;
  configuration public.crm_summary_configuration_publications;
  retained public.crm_summary_source_descriptors;
  boundary jsonb;
  signature jsonb;
  owner public.crm_summary_release_revisions;
  live_field_epoch jsonb;
  live_deadline timestamptz;
BEGIN
  SELECT p.* INTO owner FROM public.crm_summary_release_revisions p WHERE p.workspace_id=w;
  IF NOT FOUND THEN RETURN; END IF;
  IF reflector THEN bounds:=public.crm_summary_http_member_scope(w,actor,observed_at,owner.reflector_tier);
  ELSE bounds:=public.crm_summary_capture_initial_principal(w,actor,observed_at,NULL); END IF;
  IF bounds IS NULL THEN
    IF reflector AND EXISTS(SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=w AND m.user_id=actor) THEN
      membership:=true;
      RETURN NEXT;
    END IF;
    RETURN;
  END IF;
  membership:=true;
  configuration:=owner.configuration;
  IF configuration.field_id IS NULL OR owner.configuration_held THEN RETURN NEXT; RETURN; END IF;
  IF owner.policy_types='{}'::text[] AND NOT EXISTS(SELECT 1 FROM public.crm_summary_rollups c WHERE c.workspace_id=w) THEN
    captured:='{"available":true,"invalid":false,"sourceClaims":{"candidates":{"company":[],"deal":[],"person":[]},"policyDependencies":{},"lineageRoots":[]},"summary":{"totals":{"deals":0,"contacts":0,"companies":0},"attention":{"overdue":0,"stale":0,"noAmount":0,"orphaned":0},"stages":[]}}';
  ELSE
    captured:=public.crm_summary_capture_aggregate(w,actor,bounds,observed_at,pipeline_filter);
    IF captured->>'available' IS DISTINCT FROM 'true' OR configuration.revision IS DISTINCT FROM captured->>'configurationVersion' THEN
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;
  IF captured->>'invalid'='true' THEN RAISE EXCEPTION 'invalid_value: canonical native value requires review' USING ERRCODE='22023'; END IF;
  retained:=public.crm_summary_prepare_typed_descriptor(w,bounds,captured->'sourceClaims',configuration,reflector);
  IF retained.id IS NULL THEN RETURN; END IF;
  live_deadline:=least((bounds->>'nextChange')::timestamptz,(captured->>'policyDeadline')::timestamptz);
  IF retained.policy_dependencies<>'{}'::jsonb THEN live_field_epoch:=public.crm_summary_field_policy_epoch(w); END IF;
  boundary:=jsonb_build_object('configurationId',configuration.field_id,'configurationVersion',configuration.revision,
    'domainVersions',owner.domain_versions,'bounds',bounds,'fieldEpoch',live_field_epoch,
    'workspaceRevision',owner.revision::text,'nextChange',live_deadline);
  signature:=public.crm_summary_sign_issued_receipt(jsonb_build_object('workspace',w,'actor',actor,
    'transaction',transaction_timestamp(),'boundary',boundary,'descriptor',to_jsonb(retained)));
  IF signature IS NULL THEN RETURN; END IF;
  summary:=captured->'summary';
  IF retained.candidate_sets<>'{"company":[],"deal":[],"person":[]}'::jsonb THEN
    sources:=public.crm_summary_certificate_source_rows(retained,signature);
  END IF;
  revision:=owner.revision::text;
  deadline:=live_deadline::text;
  field_epoch:=live_field_epoch::text;
  transaction_at:=transaction_timestamp()::text;
  requires_lineage:=retained.lineage_roots<>'[]'::jsonb;
  packet:=signature::text;
  configuration_id:=configuration.field_id;
  configuration_version:=configuration.field_version;
  source_id:=retained.id;
  source_identity:=retained.identity;
  source_user_id:=retained.original_visibility->>'userId';
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION public.read_crm_summary_sealed(uuid,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.read_crm_summary_sealed(uuid,text,boolean) TO app_user;

COMMIT;
