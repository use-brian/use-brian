-- Owner-reviewed selective cleanup; content-free proposals and erasure receipts.
-- [COMP:api/workspace-legacy-cleanup]
BEGIN;
CREATE TABLE workspace_legacy_cleanup_reviews (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 policy_revision bigint NOT NULL,
 selection jsonb NOT NULL CHECK(jsonb_typeof(selection)='array' AND jsonb_array_length(selection) BETWEEN 1 AND 25),
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),
 payload_hash text NOT NULL CHECK(payload_hash~'^[a-f0-9]{64}$'),
 expires_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'preview' CHECK(status IN('preview','applied','cancelled')),
 receipt jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),
 CHECK((status='applied')=(receipt IS NOT NULL))
);
ALTER TABLE workspace_legacy_cleanup_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON workspace_legacy_cleanup_reviews FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='workspace_legacy_cleanup_reviews'::regclass
 WHERE r.rolname='app_user' AND r.oid<>c.relowner) THEN
 REVOKE ALL ON workspace_legacy_cleanup_reviews FROM app_user;
END IF;END $$;

CREATE FUNCTION guard_workspace_legacy_cleanup_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE ref jsonb; source jsonb; tab text; present boolean;
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN
   RAISE EXCEPTION 'legacy_cleanup_review_immutable';END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['status','receipt']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','receipt'])
   OR OLD.status<>'preview' THEN RAISE EXCEPTION 'legacy_cleanup_review_immutable';END IF;
 END IF;
 IF jsonb_typeof(NEW.evidence->'erasures') IS DISTINCT FROM 'array'
  OR jsonb_array_length(NEW.evidence->'erasures')>500 THEN RAISE EXCEPTION 'legacy_cleanup_reference_invalid';END IF;
 FOR ref IN SELECT value FROM jsonb_array_elements(NEW.evidence->'erasures') LOOP
  tab:=scope_review_source_table(ref->>'kind');
  IF tab IS NULL OR ref-ARRAY['kind','id','version']<>'{}' OR NOT ref ?& ARRAY['kind','id','version'] THEN
   RAISE EXCEPTION 'legacy_cleanup_reference_invalid';END IF;
  IF TG_OP='INSERT' THEN
   source:=read_scope_review_source(NEW.workspace_id,ref->>'kind',(ref->>'id')::uuid);
   IF source IS NULL OR source->>'version' IS DISTINCT FROM ref->>'version'
    OR jsonb_typeof(source->'compartments') IS DISTINCT FROM 'array'
    OR jsonb_array_length(source->'compartments')<>0 THEN RAISE EXCEPTION 'legacy_cleanup_reference_invalid';END IF;
  ELSIF NEW.status='applied' THEN
   EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE id=$1)',tab) INTO present USING (ref->>'id')::uuid;
   IF present THEN RAISE EXCEPTION 'legacy_cleanup_reference_invalid';END IF;
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_workspace_legacy_cleanup_review() FROM PUBLIC;
CREATE TRIGGER workspace_legacy_cleanup_immutable BEFORE INSERT OR UPDATE OR DELETE ON workspace_legacy_cleanup_reviews
 FOR EACH ROW EXECUTE FUNCTION guard_workspace_legacy_cleanup_review();

ALTER FUNCTION read_scope_review_impact_source(uuid,text,uuid) RENAME TO read_scope_review_impact_source_before_cleanup;
REVOKE ALL ON FUNCTION read_scope_review_impact_source_before_cleanup(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_scope_review_impact_source(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source jsonb; tab text; present boolean; proof record;
BEGIN
 source:=read_scope_review_impact_source_before_cleanup(w,k,i);
 IF source IS NOT NULL THEN RETURN source;END IF;
 tab:=scope_review_source_table(k);
 IF tab IS NULL THEN RETURN NULL;END IF;
 EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE id=$1)',tab) INTO present USING i;
 IF present THEN RETURN NULL;END IF;
 SELECT r.id,ref->>'version' AS version INTO proof
 FROM workspace_legacy_cleanup_reviews r CROSS JOIN LATERAL jsonb_array_elements(r.evidence->'erasures') ref
 WHERE r.workspace_id=w AND r.status='applied' AND ref->>'kind'=k AND ref->>'id'=i::text
 ORDER BY r.created_at DESC,r.id LIMIT 1 FOR SHARE OF r;
 IF NOT FOUND THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('version','erased:'||proof.id::text||':'||proof.version,'held',true,'removed',true);
END $$;
REVOKE ALL ON FUNCTION read_scope_review_impact_source(uuid,text,uuid) FROM PUBLIC;
COMMIT;
