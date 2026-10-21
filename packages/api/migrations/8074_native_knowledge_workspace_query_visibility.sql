BEGIN;
-- [COMP:api/application-persistence] Knowledge rows have workspace visibility.
-- Preserve every original current actor, catalog, field and bounded-query check.
ALTER FUNCTION application_knowledge_query_context(uuid) RENAME TO application_knowledge_query_context_before_workspace_visibility;
REVOKE ALL ON FUNCTION application_knowledge_query_context_before_workspace_visibility(uuid) FROM PUBLIC;
CREATE FUNCTION application_knowledge_query_context(w uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb;columns text[];known text[]:=ARRAY['id','workspace_id','path','title','summary','content','tags','related_ids',
 'metadata','source_id','source_sha','search_vector','created_by','created_at','updated_at','sensitivity','compartments','sensitivity_explicit','project_ids','scope_version','scope_held'];
BEGIN
 context:=application_knowledge_query_context_before_workspace_visibility(w);
 IF context IS NULL THEN RETURN NULL;END IF;
 -- This is a closed native schema contract, never a guessed General scope.
 -- A future private axis or other schema extension requires explicit review.
 SELECT array_agg(attname::text ORDER BY attname) INTO columns FROM pg_attribute
  WHERE attrelid='public.knowledge_entries'::regclass AND attnum>0 AND NOT attisdropped;
 IF columns IS NULL OR NOT(columns<@known AND known<@columns)
  OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.knowledge_entries'::regclass
   AND attname='workspace_id' AND atttypid='uuid'::regtype AND attnotnull)
  OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.knowledge_entries'::regclass
   AND attname='id' AND atttypid='uuid'::regtype AND attnotnull) THEN RETURN NULL;END IF;
 -- Row visibility has no private user/assistant dimension. Actor-specific
 -- field/source decisions and the original read bounds still qualify each use.
 RETURN context||jsonb_build_object('visibility',jsonb_build_object('userId',NULL,'assistants',NULL));
END $$;
REVOKE ALL ON FUNCTION application_knowledge_query_context(uuid) FROM PUBLIC;
COMMIT;
