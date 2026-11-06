-- [COMP:api/office-generation] Retain canonical Office sharing authority across turns.
BEGIN;
CREATE TABLE office_scope_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 artifact_id uuid NOT NULL REFERENCES office_artifacts(id) ON DELETE CASCADE,
 reader_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 policy_fingerprint text NOT NULL,
 content_version text NOT NULL,
 held boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX office_scope_observation_live ON office_scope_observations(artifact_id,reader_user_id,policy_fingerprint,content_version) WHERE NOT held;
ALTER TABLE office_scope_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON office_scope_observations FROM PUBLIC;

CREATE FUNCTION office_observation_policy(w uuid,i uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('root',to_jsonb(a)-ARRAY['title','head_version','head_version_id','updated_at'],
  'grants',coalesce((SELECT jsonb_agg(to_jsonb(g) ORDER BY g.user_id) FROM office_artifact_grants g WHERE g.artifact_id=a.id),'[]'),
  'sources',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM office_artifact_sources s WHERE s.artifact_id=a.id),'[]'))
 FROM office_artifacts a WHERE a.workspace_id=w AND a.id=i
$$;
REVOKE ALL ON FUNCTION office_observation_policy(uuid,uuid) FROM PUBLIC;

-- Explicit recipients, including a workspace audience (NULL), cannot borrow
-- the original reader's creator privilege or explicit grant.
CREATE FUNCTION office_observation_principal(w uuid,i uuid,actor uuid,assistants jsonb) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM office_artifacts a WHERE a.workspace_id=w AND a.id=i
  AND a.lifecycle_state IN('active','archived') AND (a.expires_at IS NULL OR a.expires_at>clock_timestamp())
  AND NOT scope_review_state_held('office_artifact',a.id)
  AND (actor IS NULL OR EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor))
  AND (a.mode<>'session' OR a.owner_user_id=actor)
  AND (cardinality(a.visibility_user_ids)=0 OR actor=ANY(a.visibility_user_ids))
  AND (cardinality(a.visibility_assistant_ids)=0 OR assistants='null'::jsonb
    OR EXISTS(SELECT 1 FROM unnest(a.visibility_assistant_ids) v WHERE assistants ? v::text))
  AND NOT EXISTS(SELECT 1 FROM office_artifact_grants g WHERE g.artifact_id=a.id AND g.role='deny' AND g.revoked_at IS NULL
    AND (actor IS NULL OR g.user_id=actor))
  AND (a.default_workspace_role<>'deny' OR a.owner_user_id=actor OR a.creator_user_id=actor
    OR EXISTS(SELECT 1 FROM office_artifact_grants g WHERE g.artifact_id=a.id AND g.user_id=actor AND g.role<>'deny' AND g.revoked_at IS NULL))
  AND NOT EXISTS(SELECT 1 FROM office_artifact_sources s WHERE s.artifact_id=a.id AND s.retracted_at IS NULL
    AND ((cardinality(s.visibility_user_ids)>0 AND (actor IS NULL OR NOT actor=ANY(s.visibility_user_ids)))
      OR (cardinality(s.visibility_assistant_ids)>0 AND assistants IS DISTINCT FROM 'null'::jsonb
        AND NOT EXISTS(SELECT 1 FROM unnest(s.visibility_assistant_ids) v WHERE assistants ? v::text)))))
$$;
REVOKE ALL ON FUNCTION office_observation_principal(uuid,uuid,uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION read_office_observation(w uuid,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE observation office_scope_observations; artifact office_artifacts; policy jsonb; private_read boolean;
 teams text[];tier text;
BEGIN
 SELECT * INTO observation FROM office_scope_observations WHERE workspace_id=w AND id=i FOR SHARE;
 IF NOT FOUND OR observation.held THEN RETURN '{"held":true}'; END IF;
 SELECT * INTO artifact FROM office_artifacts WHERE workspace_id=w AND id=observation.artifact_id FOR SHARE;
 IF NOT FOUND THEN RETURN '{"held":true}'; END IF;
 policy:=office_observation_policy(w,artifact.id);
 IF observation.policy_fingerprint IS DISTINCT FROM encode(sha256(convert_to(policy::text,'UTF8')),'hex')
   OR office_observation_principal(w,artifact.id,observation.reader_user_id,'null') IS NOT TRUE THEN RETURN '{"held":true}'; END IF;
 private_read:=cardinality(artifact.visibility_user_ids)>0 OR artifact.default_workspace_role='deny' OR artifact.mode='session'
   OR EXISTS(SELECT 1 FROM office_artifact_sources WHERE artifact_id=artifact.id AND retracted_at IS NULL AND cardinality(visibility_user_ids)>0);
 SELECT ARRAY(SELECT DISTINCT v FROM (SELECT unnest(artifact.compartments) v UNION ALL
   SELECT unnest(required_compartments) FROM office_artifact_sources WHERE artifact_id=artifact.id AND retracted_at IS NULL) t ORDER BY v) INTO teams;
 SELECT sensitivity INTO tier FROM (SELECT artifact.sensitivity UNION ALL SELECT sensitivity FROM office_artifact_sources
   WHERE artifact_id=artifact.id AND retracted_at IS NULL) t ORDER BY sensitivity_rank(sensitivity) DESC LIMIT 1;
 RETURN jsonb_build_object('workspaceId',w,'resourceKind','office_observation','resourceId',i,
  'version',artifact.head_version::text||':'||coalesce(artifact.head_version_id::text,'')||':'||artifact.title||':'||coalesce((SELECT canonical_hash FROM office_collab_documents WHERE artifact_id=artifact.id),''),
  'userId',CASE WHEN private_read THEN observation.reader_user_id ELSE NULL END,'assistantId',NULL,
  'sensitivity',tier,'compartments',teams,'projectIds',artifact.project_ids,'held',false,'validTo',NULL,'retractedAt',NULL);
END $$;
REVOKE ALL ON FUNCTION read_office_observation(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION capture_office_observation(w uuid,i uuid,expected jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid; observed uuid; a office_artifacts; policy text;
BEGIN
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
  OR office_artifact_scope_allows(i,w,false) IS NOT TRUE
  OR office_observation_principal(w,i,actor,coalesce(nullif(current_setting('app.agent_visibility_assistants',true),''),'null')::jsonb) IS NOT TRUE
  THEN RETURN NULL; END IF;
 SELECT * INTO a FROM office_artifacts WHERE workspace_id=w AND id=i FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM artifact_id FROM office_collab_documents WHERE artifact_id=i FOR SHARE;
 IF a.head_version::text IS DISTINCT FROM expected->>'headVersion' OR a.title IS DISTINCT FROM expected->>'title'
  OR (SELECT canonical_hash FROM office_collab_documents WHERE artifact_id=i) IS DISTINCT FROM expected->>'canonicalHash' THEN RETURN NULL; END IF;
 policy:=encode(sha256(convert_to(office_observation_policy(w,i)::text,'UTF8')),'hex');
 INSERT INTO office_scope_observations(workspace_id,artifact_id,reader_user_id,policy_fingerprint,content_version)
 VALUES(w,i,actor,policy,a.head_version::text||':'||coalesce(a.head_version_id::text,'')||':'||a.title||':'||coalesce(expected->>'canonicalHash',''))
 ON CONFLICT(artifact_id,reader_user_id,policy_fingerprint,content_version) WHERE NOT held DO UPDATE SET artifact_id=EXCLUDED.artifact_id RETURNING id INTO observed;
 RETURN read_office_observation(w,observed);
END $$;
REVOKE ALL ON FUNCTION capture_office_observation(uuid,uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION read_office_observation_authority(w uuid,i uuid,actor uuid,assistants jsonb) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT office_observation_principal(w,o.artifact_id,actor,assistants)
  AND read_office_observation(w,i)->>'held'='false' FROM office_scope_observations o WHERE o.workspace_id=w AND o.id=i),false)
$$;
REVOKE ALL ON FUNCTION read_office_observation_authority(uuid,uuid,uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION invalidate_office_observations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE artifact uuid; observation office_scope_observations;
BEGIN
 IF TG_TABLE_NAME='office_artifacts' THEN
  artifact:=OLD.id;
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['title','head_version','head_version_id','updated_at'])
    IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['title','head_version','head_version_id','updated_at']) THEN RETURN NEW; END IF;
 ELSE artifact:=CASE WHEN TG_OP='DELETE' THEN OLD.artifact_id ELSE NEW.artifact_id END; END IF;
 FOR observation IN SELECT * FROM office_scope_observations WHERE artifact_id=artifact AND NOT held FOR UPDATE LOOP
  UPDATE office_scope_observations SET held=true WHERE id=observation.id;
  PERFORM hold_scope_descendants(observation.workspace_id,'office_observation',observation.id);
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION invalidate_office_observations() FROM PUBLIC;
CREATE TRIGGER office_observation_root BEFORE UPDATE OR DELETE ON office_artifacts FOR EACH ROW EXECUTE FUNCTION invalidate_office_observations();
CREATE TRIGGER office_observation_grants AFTER INSERT OR UPDATE OR DELETE ON office_artifact_grants FOR EACH ROW EXECUTE FUNCTION invalidate_office_observations();
CREATE TRIGGER office_observation_sources AFTER INSERT OR UPDATE OR DELETE ON office_artifact_sources FOR EACH ROW EXECUTE FUNCTION invalidate_office_observations();

ALTER FUNCTION scope_source_ancestors(uuid,text,uuid) RENAME TO scope_source_ancestors_before_office_observation;
REVOKE ALL ON FUNCTION scope_source_ancestors_before_office_observation(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION scope_source_ancestors(w uuid,k text,i uuid) RETURNS TABLE(resource_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF k='office_observation' THEN RETURN QUERY SELECT id FROM office_scope_observations WHERE workspace_id=w AND id=i;
 ELSE RETURN QUERY SELECT * FROM scope_source_ancestors_before_office_observation(w,k,i); END IF;
END $$;
REVOKE ALL ON FUNCTION scope_source_ancestors(uuid,text,uuid) FROM PUBLIC;

ALTER FUNCTION read_scope_source(uuid,text,uuid) RENAME TO read_scope_source_before_office_observation;
REVOKE ALL ON FUNCTION read_scope_source_before_office_observation(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_scope_source(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF k='office_observation' THEN RETURN read_office_observation(w,i); END IF;
 RETURN read_scope_source_before_office_observation(w,k,i);
END $$;
REVOKE ALL ON FUNCTION read_scope_source(uuid,text,uuid) FROM PUBLIC;

ALTER FUNCTION read_entity_derivation_source(uuid,text,uuid) RENAME TO read_entity_derivation_source_before_office_observation;
REVOKE ALL ON FUNCTION read_entity_derivation_source_before_office_observation(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_entity_derivation_source(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid; artifact uuid;
BEGIN
 IF k<>'office_observation' THEN RETURN read_entity_derivation_source_before_office_observation(w,k,i); END IF;
 SELECT artifact_id INTO artifact FROM office_scope_observations WHERE workspace_id=w AND id=i;
 IF actor IS NULL OR artifact IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
   OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL OR office_artifact_scope_allows(artifact,w,false) IS NOT TRUE
   OR read_office_observation_authority(w,i,actor,coalesce(nullif(current_setting('app.agent_visibility_assistants',true),''),'null')::jsonb) IS NOT TRUE
   THEN RETURN NULL; END IF;
 RETURN read_office_observation(w,i);
END $$;
REVOKE ALL ON FUNCTION read_entity_derivation_source(uuid,text,uuid) FROM PUBLIC;
DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint WHERE conrelid='scope_derivation_sources'::regclass AND conname='scope_derivation_sources_source_kind_check';
 ALTER TABLE scope_derivation_sources DROP CONSTRAINT scope_derivation_sources_source_kind_check;
 EXECUTE 'ALTER TABLE scope_derivation_sources ADD CONSTRAINT scope_derivation_sources_source_kind_check CHECK (source_kind=''office_observation'' OR '||substring(definition FROM 7)||')';
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  GRANT EXECUTE ON FUNCTION capture_office_observation(uuid,uuid,jsonb),read_entity_derivation_source(uuid,text,uuid),read_office_observation_authority(uuid,uuid,uuid,jsonb) TO app_user;
 END IF;
END $$;
COMMIT;
