BEGIN;
-- [COMP:api/workflow-input-evidence] Capture, not an authorization certificate.
ALTER TABLE saved_views ADD COLUMN page_event_revision uuid;
CREATE TABLE workflow_page_event_receipts (
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 page_id uuid NOT NULL,
 revision uuid PRIMARY KEY,
 metadata jsonb NOT NULL,
 boundaries jsonb NOT NULL,
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE workflow_page_event_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON workflow_page_event_receipts FROM PUBLIC;
ALTER TABLE workflow_page_event_receipts ADD CONSTRAINT workflow_page_event_workspace_revision UNIQUE(workspace_id,revision);
CREATE TABLE workflow_page_event_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL,
 receipt_id uuid NOT NULL,
 role text NOT NULL CHECK(role IN ('changed','destination')),
 boundary jsonb NOT NULL,
 boundary_digest text NOT NULL,
 FOREIGN KEY(workspace_id,receipt_id) REFERENCES workflow_page_event_receipts(workspace_id,revision) ON DELETE CASCADE,
 UNIQUE(receipt_id,role,boundary_digest)
);
ALTER TABLE workflow_page_event_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON workflow_page_event_observations FROM PUBLIC;

-- Keep the principal boundary, not just labels. Unlinked Teamspace membership
-- cannot be represented by an empty compartments array.
CREATE FUNCTION workflow_page_event_boundary(p saved_views) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t teamspaces; g workspace_groups; tier text:=p.clearance;
 compartment text; unavailable boolean:=false;
BEGIN
 IF p.teamspace_id IS NOT NULL THEN
  SELECT * INTO t FROM teamspaces WHERE id=p.teamspace_id AND workspace_id=p.workspace_id FOR SHARE;
  IF NOT FOUND THEN unavailable:=true;
  ELSE
   IF sensitivity_rank(t.sensitivity)>sensitivity_rank(tier) THEN tier:=t.sensitivity; END IF;
   IF t.workspace_group_id IS NOT NULL THEN
    SELECT * INTO g FROM workspace_groups WHERE id=t.workspace_group_id AND workspace_id=p.workspace_id FOR SHARE;
    IF NOT FOUND OR g.status IS DISTINCT FROM 'active' OR g.compartment_key IS NULL THEN unavailable:=true;
    ELSE compartment:=g.compartment_key; END IF;
   END IF;
  END IF;
 END IF;
 RETURN jsonb_build_object('pageId',p.id,'workspaceId',p.workspace_id,
  'creatorId',p.created_by,'teamspaceId',p.teamspace_id,'departmentId',t.workspace_group_id,
  'principalBoundary',CASE WHEN p.teamspace_id IS NULL THEN 'private' WHEN t.workspace_group_id IS NULL THEN 'teamspace' ELSE 'department' END,
  'sensitivity',tier,'compartments',CASE WHEN compartment IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(compartment) END,
  'projectIds',CASE WHEN p.project_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p.project_id) END,
  'unavailable',unavailable);
END $$;

CREATE FUNCTION assign_page_event_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN NEW.page_event_revision:=gen_random_uuid(); RETURN NEW; END $$;
CREATE TRIGGER page_event_revision BEFORE INSERT OR UPDATE ON saved_views
 FOR EACH ROW EXECUTE FUNCTION assign_page_event_revision();

CREATE FUNCTION capture_workflow_page_event_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE parent saved_views; boundaries jsonb; action text;
BEGIN
 IF TG_OP='INSERT' THEN action:='created';
 ELSIF OLD.created_event_pending AND NOT NEW.created_event_pending THEN action:='created';
 ELSIF nullif(current_setting('app.page_event_moved_id',true),'')=NEW.id::text
  OR NEW.nest_parent_id IS DISTINCT FROM OLD.nest_parent_id THEN action:='moved';
 ELSE action:='updated'; END IF;
 boundaries:=jsonb_build_object('changed',workflow_page_event_boundary(NEW));
 IF NEW.nest_parent_id IS NOT NULL THEN
  SELECT * INTO parent FROM saved_views WHERE id=NEW.nest_parent_id AND workspace_id=NEW.workspace_id FOR SHARE;
  boundaries:=boundaries||jsonb_build_object('destination',CASE WHEN FOUND THEN workflow_page_event_boundary(parent)
   ELSE jsonb_build_object('pageId',NEW.nest_parent_id,'unavailable',true) END);
 END IF;
 INSERT INTO workflow_page_event_receipts(workspace_id,page_id,revision,metadata,boundaries)
 VALUES(NEW.workspace_id,NEW.id,NEW.page_event_revision,
  jsonb_build_object('pageId',NEW.id,'title',NEW.name,'parentId',NEW.nest_parent_id,
   'creatorId',NEW.created_by,'actorId',nullif(current_setting('app.current_user_id',true),'')::uuid,
   'writeKind',lower(TG_OP),'action',action,'createdEventPending',NEW.created_event_pending),boundaries);
 RETURN NEW;
END $$;
CREATE TRIGGER page_event_receipt_written AFTER INSERT OR UPDATE ON saved_views
 FOR EACH ROW EXECUTE FUNCTION capture_workflow_page_event_receipt();
REVOKE ALL ON FUNCTION workflow_page_event_boundary(saved_views),assign_page_event_revision(),capture_workflow_page_event_receipt() FROM PUBLIC;

-- Doc-sync has no single actor: a settled snapshot can aggregate writers.
-- Capture current protection without mutating the page or reusing a stale
-- metadata-write receipt. Callable only by the trusted owner connection.
CREATE FUNCTION capture_page_body_event_context(target uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p saved_views; parent saved_views; revision uuid:=gen_random_uuid(); boundaries jsonb; metadata jsonb;
BEGIN
 SELECT * INTO p FROM saved_views WHERE id=target FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 boundaries:=jsonb_build_object('changed',workflow_page_event_boundary(p));
 IF p.nest_parent_id IS NOT NULL THEN
  SELECT * INTO parent FROM saved_views WHERE id=p.nest_parent_id AND workspace_id=p.workspace_id FOR SHARE;
  boundaries:=boundaries||jsonb_build_object('destination',CASE WHEN FOUND THEN workflow_page_event_boundary(parent)
   ELSE jsonb_build_object('pageId',p.nest_parent_id,'unavailable',true) END);
 END IF;
 metadata:=jsonb_build_object('pageId',p.id,'title',p.name,'parentId',p.nest_parent_id,
  'creatorId',p.created_by,'actorId',NULL,'writeKind','body','action','updated');
 INSERT INTO workflow_page_event_receipts(workspace_id,page_id,revision,metadata,boundaries)
 VALUES(p.workspace_id,p.id,revision,metadata,boundaries);
 RETURN jsonb_build_object('sourceVersion',revision,'workspaceId',p.workspace_id,'parentId',p.nest_parent_id,'title',p.name);
END $$;
REVOKE ALL ON FUNCTION capture_page_body_event_context(uuid) FROM PUBLIC;

-- This checks only the principal axis. Labels, independent assistant caps and
-- frozen authority must ALSO pass the canonical scope validator.
CREATE FUNCTION page_event_principal_allows(w uuid,actor uuid,boundary jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT coalesce(
  boundary->>'workspaceId'=w::text AND boundary->>'unavailable'='false'
  AND EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor)
  AND CASE boundary->>'principalBoundary'
   WHEN 'private' THEN boundary->>'creatorId'=actor::text
   WHEN 'department' THEN boundary->>'departmentId' IS NOT NULL
   WHEN 'teamspace' THEN EXISTS(SELECT 1 FROM teamspace_members m JOIN teamspaces t ON t.id=m.teamspace_id
    WHERE t.workspace_id=w AND m.teamspace_id=(boundary->>'teamspaceId')::uuid AND m.user_id=actor)
   ELSE false END,false)
$$;

CREATE FUNCTION read_page_event_authority(w uuid,receipt_id uuid,actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE receipt workflow_page_event_receipts; item record; live saved_views;
 current_boundary jsonb; projections jsonb:='[]'; allowed boolean;
BEGIN
 PERFORM id FROM workspaces WHERE id=w FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM user_id FROM workspace_members WHERE workspace_id=w AND user_id=actor FOR SHARE;
 SELECT * INTO receipt FROM workflow_page_event_receipts
  WHERE workspace_id=w AND revision=receipt_id FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 -- Table locks keep membership removal and Teamspace relinking from racing
 -- with admission on the caller's transaction. No role substitutes an edge.
 LOCK TABLE teamspace_members IN SHARE MODE;
 FOR item IN SELECT key,value FROM jsonb_each(receipt.boundaries)
  WHERE key='changed' OR receipt.metadata->>'action' IN ('created','moved') ORDER BY key LOOP
  allowed:=page_event_principal_allows(w,actor,item.value);
  SELECT * INTO live FROM saved_views WHERE workspace_id=w AND id=(item.value->>'pageId')::uuid FOR SHARE;
  current_boundary:=NULL;
  IF FOUND THEN
   current_boundary:=workflow_page_event_boundary(live);
   allowed:=allowed AND page_event_principal_allows(w,actor,current_boundary);
  END IF;
  projections:=projections||jsonb_build_array(jsonb_build_object('role',item.key,
   'saved',item.value,'current',current_boundary,'principalAllowed',allowed,
   'savedSource',page_event_scope_descriptor(receipt_id,item.key,item.value,false),
   'currentSource',capture_page_event_observation(w,receipt_id,item.key,current_boundary)));
 END LOOP;
 RETURN jsonb_build_object('metadata',receipt.metadata,'boundaries',projections);
END $$;
REVOKE ALL ON FUNCTION page_event_principal_allows(uuid,uuid,jsonb),read_page_event_authority(uuid,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION page_event_scope_descriptor(receipt_id uuid,role text,boundary jsonb,live boolean) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN boundary IS NULL OR boundary->>'unavailable' IS DISTINCT FROM 'false'
  OR role NOT IN ('changed','destination') THEN NULL ELSE
  jsonb_build_object('workspaceId',boundary->>'workspaceId',
   'resourceKind',CASE WHEN live THEN 'page_live_' ELSE 'page_event_' END||role,
   'resourceId',receipt_id,'version',CASE WHEN live THEN encode(sha256(convert_to(boundary::text,'UTF8')),'hex') ELSE receipt_id::text END,
   'userId',CASE WHEN boundary->>'principalBoundary'='private' THEN boundary->>'creatorId' ELSE NULL END,
   'assistantId',NULL,'sensitivity',boundary->>'sensitivity',
   'compartments',boundary->'compartments','projectIds',boundary->'projectIds') END
$$;
REVOKE ALL ON FUNCTION page_event_scope_descriptor(uuid,text,jsonb,boolean) FROM PUBLIC;

CREATE FUNCTION capture_page_event_observation(w uuid,receipt uuid,causal_role text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE digest text; observation uuid; stored jsonb;
BEGIN
 IF b IS NULL OR b->>'unavailable' IS DISTINCT FROM 'false' THEN RETURN NULL; END IF;
 IF b->>'workspaceId' IS DISTINCT FROM w::text OR causal_role NOT IN ('changed','destination') THEN
  RAISE EXCEPTION 'page_event_observation_conflict'; END IF;
 digest:=encode(sha256(convert_to(b::text,'UTF8')),'hex');
 INSERT INTO workflow_page_event_observations(workspace_id,receipt_id,role,boundary,boundary_digest)
 VALUES(w,receipt,causal_role,b,digest) ON CONFLICT(receipt_id,role,boundary_digest) DO NOTHING;
 SELECT id,boundary INTO observation,stored FROM workflow_page_event_observations
  WHERE workspace_id=w AND receipt_id=receipt AND role=causal_role AND boundary_digest=digest FOR SHARE;
 IF observation IS NULL OR stored IS DISTINCT FROM b THEN RAISE EXCEPTION 'page_event_observation_conflict'; END IF;
 RETURN page_event_scope_descriptor(observation,causal_role,stored,true);
END $$;
REVOKE ALL ON FUNCTION capture_page_event_observation(uuid,uuid,text,jsonb) FROM PUBLIC;

CREATE FUNCTION keep_page_event_observation_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'page_event_observation_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER page_event_observation_immutable BEFORE UPDATE ON workflow_page_event_observations
 FOR EACH ROW EXECUTE FUNCTION keep_page_event_observation_immutable();
REVOKE ALL ON FUNCTION keep_page_event_observation_immutable() FROM PUBLIC;

CREATE FUNCTION read_page_scope_authority(w uuid,kind text,source_id uuid,actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE observation workflow_page_event_observations; receipt uuid:=source_id;
 causal_role text; authority jsonb; item jsonb; source jsonb; allowed boolean;
BEGIN
 IF kind NOT IN ('page_event_changed','page_event_destination','page_live_changed','page_live_destination') THEN RETURN NULL; END IF;
 causal_role:=CASE WHEN kind LIKE '%_destination' THEN 'destination' ELSE 'changed' END;
 IF kind LIKE 'page_live_%' THEN
  SELECT * INTO observation FROM workflow_page_event_observations WHERE workspace_id=w AND id=source_id AND role=causal_role FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  receipt:=observation.receipt_id;
 END IF;
 authority:=read_page_event_authority(w,receipt,actor);
 IF authority IS NULL THEN RETURN NULL; END IF;
 SELECT value INTO item FROM jsonb_array_elements(authority->'boundaries') WHERE value->>'role'=causal_role;
 IF NOT FOUND THEN RETURN NULL; END IF;
 allowed:=(item->>'principalAllowed')::boolean;
 allowed:=allowed AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(authority->'boundaries') b
  WHERE b->>'principalAllowed' IS DISTINCT FROM 'true');
 IF kind LIKE 'page_live_%' THEN
  allowed:=allowed AND page_event_principal_allows(w,actor,observation.boundary);
  source:=page_event_scope_descriptor(source_id,causal_role,observation.boundary,true);
 ELSE source:=item->'savedSource'; END IF;
 RETURN jsonb_build_object('source',source,'requiredSources',
  (SELECT jsonb_agg(s) FROM jsonb_array_elements(authority->'boundaries') b
    CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(b->'savedSource',b->'currentSource')) s
    WHERE s IS DISTINCT FROM 'null'::jsonb),
  'principalAllowed',allowed,'receiptId',receipt);
END $$;
REVOKE ALL ON FUNCTION read_page_scope_authority(uuid,text,uuid,uuid) FROM PUBLIC;

COMMIT;
