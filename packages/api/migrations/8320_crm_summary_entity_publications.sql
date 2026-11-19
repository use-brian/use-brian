-- [COMP:crm/r2-store] Publish canonical CRM record/source identity in the owning write transaction.
BEGIN;

-- Actor-independent exact source envelopes. A shared ID means the full scope
-- tuple is equal, including private ownership and assistant partition.
CREATE TABLE public.crm_summary_scope_classes (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid,
  assistant_id uuid,
  sensitivity text NOT NULL CHECK (sensitivity IN('public','internal','confidential')),
  compartments text[] NOT NULL,
  project_ids uuid[] NOT NULL,
  PRIMARY KEY(workspace_id,id),
  UNIQUE NULLS NOT DISTINCT(workspace_id,user_id,assistant_id,sensitivity,compartments,project_ids)
);

-- The canonical entity remains the business owner. This publication contains
-- current identity, shape, scope and revision, without a second mutable copy
-- of field values. Separate lineage facts retain their own versions.
CREATE TABLE public.crm_summary_entity_publications (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN('person','company','deal')),
  record_version bigint NOT NULL CHECK (record_version>0),
  scope_class_id uuid NOT NULL,
  created_by_user_id uuid,
  PRIMARY KEY(workspace_id,entity_id),
  FOREIGN KEY(workspace_id,scope_class_id) REFERENCES public.crm_summary_scope_classes(workspace_id,id)
);
CREATE INDEX crm_summary_entity_publications_domain ON public.crm_summary_entity_publications(workspace_id,kind,scope_class_id,entity_id);

-- Domain versions cover insertion, retraction, physical replacement and scope
-- movement. A single change publishes relevant kind revisions without walking
-- descendants or replaying policy. The future release observer tracks exact
-- covered authority/version groups and never uses an earlier allow decision.
CREATE TABLE public.crm_summary_entity_domain_versions (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN('person','company','deal')),
  revision bigint NOT NULL CHECK (revision>0),
  PRIMARY KEY(workspace_id,kind)
);
ALTER TABLE public.crm_summary_scope_classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_summary_entity_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_summary_entity_domain_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crm_summary_scope_classes,public.crm_summary_entity_publications,public.crm_summary_entity_domain_versions FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_entity_scope_class(
  w uuid, private_user uuid, assistant uuid, tier text, labels text[], projects uuid[]
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE scope_id uuid;
BEGIN
  -- Normalize only the underlying set equality. Never group different visibility axes.
  labels:=ARRAY(SELECT DISTINCT item FROM unnest(labels) item ORDER BY item);
  projects:=ARRAY(SELECT DISTINCT item FROM unnest(projects) item ORDER BY item);
  SELECT c.id INTO scope_id FROM public.crm_summary_scope_classes c WHERE c.workspace_id=w
    AND c.user_id IS NOT DISTINCT FROM private_user AND c.assistant_id IS NOT DISTINCT FROM assistant
    AND c.sensitivity=tier AND c.compartments=labels AND c.project_ids=projects;
  IF FOUND THEN RETURN scope_id; END IF;
  INSERT INTO public.crm_summary_scope_classes(workspace_id,user_id,assistant_id,sensitivity,compartments,project_ids)
    VALUES(w,private_user,assistant,tier,labels,projects) ON CONFLICT DO NOTHING RETURNING id INTO scope_id;
  IF FOUND THEN RETURN scope_id; END IF;
  SELECT c.id INTO STRICT scope_id FROM public.crm_summary_scope_classes c WHERE c.workspace_id=w
    AND c.user_id IS NOT DISTINCT FROM private_user AND c.assistant_id IS NOT DISTINCT FROM assistant
    AND c.sensitivity=tier AND c.compartments=labels AND c.project_ids=projects;
  RETURN scope_id;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_entity_scope_class(uuid,uuid,uuid,text,text[],uuid[]) FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_publish_entity(e public.entities) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE scope_id uuid;
BEGIN
  IF e.workspace_id IS NULL OR e.kind NOT IN('person','company','deal') THEN RETURN; END IF;
  IF e.valid_to IS NOT NULL OR e.retracted_at IS NOT NULL OR e.scope_held THEN
    DELETE FROM public.crm_summary_entity_publications p WHERE p.workspace_id=e.workspace_id AND p.entity_id=e.id;
    RETURN;
  END IF;
  scope_id:=public.crm_summary_entity_scope_class(e.workspace_id,e.user_id,e.assistant_id,e.sensitivity,e.compartments,e.project_ids);
  INSERT INTO public.crm_summary_entity_publications AS p(workspace_id,entity_id,kind,record_version,scope_class_id,created_by_user_id)
    VALUES(e.workspace_id,e.id,e.kind,e.scope_version,scope_id,e.created_by_user_id)
    ON CONFLICT(workspace_id,entity_id) DO UPDATE SET kind=excluded.kind,record_version=excluded.record_version,
      scope_class_id=excluded.scope_class_id,created_by_user_id=excluded.created_by_user_id
    WHERE (p.kind,p.record_version,p.scope_class_id,p.created_by_user_id) IS DISTINCT FROM
      (excluded.kind,excluded.record_version,excluded.scope_class_id,excluded.created_by_user_id);
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_publish_entity(public.entities) FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_advance_entity_domain(w uuid, k text) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  INSERT INTO public.crm_summary_entity_domain_versions(workspace_id,kind,revision)
    SELECT w,k,nextval('public.application_policy_revision_seq') WHERE k IN('person','company','deal')
      AND EXISTS(SELECT 1 FROM public.workspaces WHERE id=w)
    ON CONFLICT(workspace_id,kind) DO UPDATE SET revision=nextval('public.application_policy_revision_seq');
$$;
REVOKE ALL ON FUNCTION public.crm_summary_advance_entity_domain(uuid,text) FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_entity_publication_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' OR TG_OP='UPDATE' AND (OLD.workspace_id,OLD.kind) IS DISTINCT FROM (NEW.workspace_id,NEW.kind) THEN
    DELETE FROM public.crm_summary_entity_publications p WHERE p.workspace_id=OLD.workspace_id AND p.entity_id=OLD.id;
    PERFORM public.crm_summary_advance_entity_domain(OLD.workspace_id,OLD.kind);
  END IF;
  IF TG_OP<>'DELETE' THEN
    IF TG_OP='UPDATE' AND (OLD.workspace_id,OLD.kind,OLD.id,OLD.scope_version,OLD.scope_held,OLD.valid_to,OLD.retracted_at,
      OLD.user_id,OLD.assistant_id,OLD.sensitivity,OLD.compartments,OLD.project_ids,OLD.created_by_user_id)
      IS NOT DISTINCT FROM (NEW.workspace_id,NEW.kind,NEW.id,NEW.scope_version,NEW.scope_held,NEW.valid_to,NEW.retracted_at,
        NEW.user_id,NEW.assistant_id,NEW.sensitivity,NEW.compartments,NEW.project_ids,NEW.created_by_user_id) THEN RETURN NULL; END IF;
    PERFORM public.crm_summary_publish_entity(NEW);
    PERFORM public.crm_summary_advance_entity_domain(NEW.workspace_id,NEW.kind);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_entity_publication_changed() FROM PUBLIC,app_user;

-- Backfill and trigger ownership share one transaction, excluding a concurrent
-- entity write during the initial projection. The activated reader is a later
-- migration, and canonical readers continue operating during this stage.
LOCK TABLE public.entities IN SHARE ROW EXCLUSIVE MODE;
CREATE TRIGGER crm_summary_entity_publication_changed AFTER INSERT OR UPDATE OR DELETE ON public.entities
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_entity_publication_changed();
WITH live AS MATERIALIZED (
  SELECT e.workspace_id,e.id,e.kind,e.scope_version,e.user_id,e.assistant_id,e.sensitivity,e.created_by_user_id,
    ARRAY(SELECT DISTINCT label FROM unnest(e.compartments) label ORDER BY label) AS compartments,
    ARRAY(SELECT DISTINCT project FROM unnest(e.project_ids) project ORDER BY project) AS project_ids
  FROM public.entities e WHERE e.workspace_id IS NOT NULL AND e.kind IN('person','company','deal')
    AND e.valid_to IS NULL AND e.retracted_at IS NULL AND NOT e.scope_held
), classes AS (
  INSERT INTO public.crm_summary_scope_classes(workspace_id,user_id,assistant_id,sensitivity,compartments,project_ids)
  SELECT DISTINCT workspace_id,user_id,assistant_id,sensitivity,compartments,project_ids FROM live
  RETURNING workspace_id,id,user_id,assistant_id,sensitivity,compartments,project_ids
)
INSERT INTO public.crm_summary_entity_publications(workspace_id,entity_id,kind,record_version,scope_class_id,created_by_user_id)
  SELECT e.workspace_id,e.id,e.kind,e.scope_version,c.id,e.created_by_user_id FROM live e
  JOIN classes c ON c.workspace_id=e.workspace_id AND c.user_id IS NOT DISTINCT FROM e.user_id AND c.assistant_id IS NOT DISTINCT FROM e.assistant_id
    AND c.sensitivity=e.sensitivity AND c.compartments=e.compartments AND c.project_ids=e.project_ids;
INSERT INTO public.crm_summary_entity_domain_versions(workspace_id,kind,revision)
  SELECT workspace_id,kind,nextval('public.application_policy_revision_seq') FROM (
    SELECT DISTINCT workspace_id,kind FROM public.crm_summary_entity_publications
  ) domains;
COMMIT;
