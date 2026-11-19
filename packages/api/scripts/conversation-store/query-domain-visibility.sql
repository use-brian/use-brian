
DECLARE frozen application_query_domains;parent jsonb;current_bounds jsonb;visibility jsonb;result jsonb;scanned jsonb;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;state jsonb;
BEGIN
 SELECT * INTO frozen FROM application_query_domains WHERE workspace_id=w AND id=i AND origin='{"kind":"native","moduleKey":"native"}' AND type_key=t;
 IF NOT FOUND OR frozen.domain->>'kind' IS DISTINCT FROM 'session_query_domain_v1'
  OR frozen.domain-ARRAY['kind','sessionId','throughSequence','fields','bounds','visibility','parentFingerprint','candidates','points']<>'{}'
  OR frozen.domain->'fields' IS DISTINCT FROM to_jsonb(fields) THEN RETURN '{}'::jsonb;END IF;
 parent:=application_session_query_parent(w,(frozen.domain->>'sessionId')::uuid);
 IF parent IS NULL OR parent->'fingerprint' IS DISTINCT FROM frozen.domain->'parentFingerprint' THEN RETURN '{}'::jsonb;END IF;
 current_bounds:=application_session_query_bounds(w,parent);
 IF current_bounds IS NULL OR application_query_scope_union_contains(frozen.domain->'bounds',jsonb_build_array(current_bounds),4096)->>'contains' IS DISTINCT FROM 'true' THEN RETURN '{}'::jsonb;END IF;
 visibility:=jsonb_build_object('userId',CASE WHEN current_setting('app.agent_shared_audience',true)='true' THEN NULL ELSE actor END,
  'assistants',coalesce(nullif(current_setting('app.agent_visibility_assistants',true),'')::jsonb,'null'::jsonb));
 -- The frozen assistant visibility is capture metadata, not authority. A reader
 -- whose visibility does not contain it admits the domain only when every frozen
 -- point is unscoped or visible to it; the rescan below then reproduces every
 -- candidate and point from this reader's own current admission, or refuses.
 -- The point check runs only when containment fails, so the contained path keeps
 -- the original simple expressions.
 IF frozen.domain#>>'{visibility,userId}' IS NOT NULL AND frozen.domain#>>'{visibility,userId}' IS DISTINCT FROM visibility->>'userId' THEN RETURN '{}'::jsonb;END IF;
 IF visibility->'assistants'<>'null'::jsonb AND (frozen.domain#>'{visibility,assistants}'='null'::jsonb
   OR NOT coalesce(frozen.domain#>'{visibility,assistants}'<@(visibility->'assistants'),false)) THEN
  IF jsonb_typeof(frozen.domain->'points') IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(frozen.domain->'points') point
   WHERE jsonb_typeof(point->'source') IS DISTINCT FROM 'object' OR point#>>'{source,assistantId}' IS NOT NULL
    AND NOT coalesce(visibility->'assistants' ? (point#>>'{source,assistantId}'),false)) THEN RETURN '{}'::jsonb;END IF;
 END IF;
 result:=conversation_dag_scan(w,(frozen.domain->>'sessionId')::uuid,t,(frozen.domain->>'throughSequence')::integer,fields,frozen.domain->'bounds',frozen.domain->'visibility',memo,slots,completed);

 memo:=coalesce(result->'memo',memo);scanned:=result->'value';
 IF scanned IS NULL OR scanned->'candidates' IS DISTINCT FROM frozen.domain->'candidates' OR scanned->'points' IS DISTINCT FROM frozen.domain->'points' THEN RETURN '{}'::jsonb;END IF;
 state:=jsonb_build_object('values','{}'::jsonb,'source',parent->'scope','recordVersion','1',
  'sourceKind','application_query_domain','sourceId',i,'sourceVersion',frozen.identity,'ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('kind','session_query_domain_v1','identity',frozen.identity,'fields',fields)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','session_query_domain_v1','identity',frozen.identity,'policies',scanned->'policies')),
  'references','[]'::jsonb,'queryPoints',frozen.domain->'points');
 RETURN jsonb_build_object('value',state,'children',result->'children');
END 
