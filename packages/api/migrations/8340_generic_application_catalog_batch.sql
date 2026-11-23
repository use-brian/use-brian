BEGIN;
-- [COMP:api/application-records] [COMP:api/doc-entity-store]
-- A catalog list shares its caller's workspace floor or app catalog while each
-- protected schema retains the canonical field mask for that type and version.
CREATE FUNCTION public.read_generic_application_catalog_states(w uuid, type_ids uuid[])
RETURNS TABLE(type_id uuid, state jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF coalesce(cardinality(type_ids),0)=0 OR EXISTS(
  SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.entity_types'::regclass
  WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))
 ) THEN RETURN; END IF;

 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN
  IF public.application_current_maxima()->>'workspaceId' IS DISTINCT FROM w::text THEN RETURN; END IF;
  RETURN QUERY
   SELECT t.id,jsonb_build_object('schemaVersion',t.schema_version::text,
     'fields',array_agg(DISTINCT field->>'key' ORDER BY field->>'key'))
   FROM public.application_generic_catalog(NULL) resource
   JOIN public.entity_types t ON t.id=(resource#>>'{origin,entityTypeId}')::uuid
     AND t.workspace_id=w AND t.id=ANY(type_ids)
   CROSS JOIN LATERAL jsonb_array_elements(resource->'fields') field
   GROUP BY t.id
   HAVING bool_and(resource->>'schemaVersion' IS NOT DISTINCT FROM t.schema_version::text);
  RETURN;
 END IF;

 IF public.application_native_query_bounds(w) IS NULL THEN RETURN; END IF;
 RETURN QUERY
  WITH selected AS MATERIALIZED (
   SELECT t.id,t.properties,t.schema_version,origin.value AS origin,'record.'||t.id AS canonical_type,
          EXISTS(SELECT 1 FROM public.application_native_resource_owners o
            JOIN public.application_native_field_contracts c USING(module_key)
            WHERE o.workspace_id=w AND o.origin=origin.value AND o.resource_type='record.'||t.id) AS registered
   FROM public.entity_types t
   CROSS JOIN LATERAL (SELECT jsonb_build_object('kind','generic','entityTypeId',t.id) AS value) origin
   WHERE t.workspace_id=w AND t.id=ANY(type_ids)
  ), protected AS MATERIALIZED (
   SELECT s.id,s.schema_version,public.read_native_application_field_catalog(w,s.origin,s.canonical_type) AS mask
   FROM selected s WHERE s.registered
  )
  SELECT s.id,jsonb_build_object('schemaVersion',s.schema_version::text,'fields',
   ARRAY(SELECT DISTINCT property->>'name' FROM jsonb_array_elements(s.properties) property ORDER BY property->>'name'))
  FROM selected s WHERE NOT s.registered
  UNION ALL
  SELECT p.id,jsonb_build_object('schemaVersion',p.schema_version::text,'fields',
   ARRAY(SELECT jsonb_array_elements_text(p.mask->'readFields') AS field
         UNION SELECT jsonb_array_elements_text(p.mask->'writeFields') ORDER BY field))
  FROM protected p WHERE p.mask->>'schemaVersion'=p.schema_version::text;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN;
END $$;
REVOKE ALL ON FUNCTION public.read_generic_application_catalog_states(uuid,uuid[]) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.read_generic_application_catalog_state(w uuid,type_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT state FROM public.read_generic_application_catalog_states(w,ARRAY[type_id])
$$;

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  GRANT EXECUTE ON FUNCTION public.read_generic_application_catalog_states(uuid,uuid[]) TO app_user;
 END IF;
END $$;
COMMIT;
