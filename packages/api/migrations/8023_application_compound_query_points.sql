BEGIN;
-- [COMP:api/application-records] Refine finite ID/self/relationship conjunctions
-- through current canonical query evidence; retain absent/excluded obligations.
CREATE OR REPLACE FUNCTION application_refine_query_points(w uuid,p_type uuid,p_alias text,formula jsonb,required_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE origin jsonb:=jsonb_build_object('kind','generic','entityTypeId',p_type); clause jsonb; identity_value jsonb;
 id_text text; canonical_id uuid; version_value text; child jsonb; retained_ids jsonb; clauses jsonb:='[]';
 points jsonb:='[]'; checked_ids jsonb:='[]'; candidates jsonb:='[]'; attempts int:=0;
BEGIN
 IF public.application_query_domain_contains(formula,formula,'{}') IS NOT TRUE THEN RETURN NULL; END IF;
 FOR clause IN SELECT value FROM jsonb_array_elements(formula->'clauses') LOOP
  IF clause#>'{selector,ids}'='null' THEN clauses:=clauses||jsonb_build_array(clause);CONTINUE; END IF;
  retained_ids:=clause#>'{selector,ids}';
  FOR identity_value IN SELECT value FROM jsonb_array_elements(clause#>'{selector,ids}') LOOP
   attempts:=attempts+1;
   IF attempts>4096 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501'; END IF;
   id_text:=identity_value#>>'{}';
   IF id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    checked_ids:=checked_ids||jsonb_build_array(id_text);CONTINUE;
   END IF;
   canonical_id:=id_text::uuid;checked_ids:=checked_ids||jsonb_build_array(canonical_id);
   SELECT projected.record_version::text INTO version_value FROM public.application_generic_projection(p_type,p_alias,'query',canonical_id) projected;
   IF NOT FOUND THEN CONTINUE; END IF;
   candidates:=candidates||jsonb_build_array(jsonb_build_object('id',canonical_id,'version',version_value));
   child:=public.application_compute_field_envelope(w,origin,'record.'||p_type,canonical_id,'query',NULL,required_fields,1);
   IF child IS NULL THEN CONTINUE; END IF;
   IF child#>>'{state,recordVersion}' IS DISTINCT FROM version_value THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
   IF public.application_query_scope_admits_point(clause->'scope',child->'source') IS NOT TRUE THEN CONTINUE; END IF;
   IF clause#>>'{selector,ownerId}' IS NOT NULL
     AND child#>>'{state,ownerId}' IS DISTINCT FROM clause#>>'{selector,ownerId}'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(clause#>'{selector,relationships}') relationship
      WHERE public.application_relationship_matches(w,origin,canonical_id::text,relationship->>'resolverKey',relationship->>'anchorId') IS NOT TRUE) THEN CONTINUE; END IF;
   points:=points||jsonb_build_array(jsonb_build_object('id',canonical_id,'version',version_value,'fields',required_fields,'source',child->'source'));
   SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO retained_ids FROM jsonb_array_elements(retained_ids) WHERE value<>identity_value;
  END LOOP;
  -- A vacuous clause retains original relationship anchor dependencies without
  -- inventing a remaining business domain or borrowing the original actor.
  IF jsonb_array_length(retained_ids)>0 THEN
   clauses:=clauses||jsonb_build_array(jsonb_set(clause,'{selector,ids}',retained_ids));
  ELSIF jsonb_array_length(clause#>'{selector,relationships}')>0 THEN
   clauses:=clauses||jsonb_build_array(jsonb_set(jsonb_set(clause,'{selector,ids}','[]'::jsonb),'{selector,empty}','true'::jsonb));
  END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO points FROM (SELECT DISTINCT value FROM jsonb_array_elements(points)) unique_points;
 SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO checked_ids FROM (SELECT DISTINCT value FROM jsonb_array_elements(checked_ids)) unique_ids;
 SELECT coalesce(jsonb_agg(value ORDER BY value->>'id'),'[]') INTO candidates FROM (SELECT DISTINCT value FROM jsonb_array_elements(candidates)) unique_candidates;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(candidates) candidate GROUP BY candidate->>'id' HAVING count(*)>1) THEN
  RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('formula',formula||jsonb_build_object('clauses',clauses),'queryPoints',points,'checkedIds',checked_ids,'candidates',candidates);
END $$;
REVOKE ALL ON FUNCTION application_refine_query_points(uuid,uuid,text,jsonb,text[]) FROM PUBLIC;

COMMIT;
