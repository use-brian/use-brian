-- Explicit source-released observations retain current exact-transaction authority.
-- Existing applied assets remain immutable. No payload/ACL store is added.
BEGIN;
DO $retention$
DECLARE signature text;definition text;before text;after text;
BEGIN
 FOREACH signature IN ARRAY ARRAY['external_source_retention_allowed_before_service(uuid,uuid,text)','external_source_retention_allowed(uuid,uuid,text)'] LOOP
  definition:=pg_get_functiondef(signature::regprocedure);
  before:=$old$o.observation->'retention'->>'mode'='governed'$old$;
  after:=$new$(o.observation->'retention'->>'mode'='governed' OR
    o.observation->'retention'->>'mode'='released_snapshot'
    AND length(o.observation#>>'{retention,releaseId}')>0
    AND jsonb_typeof(o.observation#>'{retention,expiresAt}')='number'
    AND (o.observation#>>'{retention,expiresAt}')::numeric>extract(epoch FROM clock_timestamp())*1000)$new$;
  IF position(before IN definition)=0 THEN RAISE EXCEPTION 'source_retention_definition_changed';END IF;
  -- CREATE OR REPLACE preserves the existing owner, ACL and search path.
  EXECUTE replace(definition,before,after);
 END LOOP;
END $retention$;
-- Expiry applies to context/delivery as well as new retention, even if a stale
-- trusted host receipt remains within its short transaction window.
DO $expiry$
DECLARE definition text;before text;after text;
BEGIN
 definition:=pg_get_functiondef('external_source_snapshot(uuid,uuid)'::regprocedure);
 before:=$old$BEGIN
 SELECT p.scoped_app_id$old$;
 after:=$new$BEGIN
 IF EXISTS(SELECT 1 FROM external_source_observations o WHERE o.workspace_id=w AND o.id=i
  AND o.observation#>>'{retention,mode}'='released_snapshot'
  AND (jsonb_typeof(o.observation#>'{retention,expiresAt}') IS DISTINCT FROM 'number'
   OR length(coalesce(o.observation#>>'{retention,releaseId}',''))=0
   OR (o.observation#>>'{retention,expiresAt}')::numeric<=extract(epoch FROM clock_timestamp())*1000)) THEN RETURN '{"held":true}'::jsonb;END IF;
 SELECT p.scoped_app_id$new$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'source_snapshot_definition_changed';END IF;
 EXECUTE replace(definition,before,after);
END $expiry$;
COMMIT;
