BEGIN;
-- [COMP:api/application-persistence] Selected Memory READ decisions remain
-- independent of mutation masks. Every canonical admission check stays in place.
-- Keep the exact current legacy digest privately for existing observations;
-- neither an old role assignment nor an unknown policy can be reconstructed.
DO $memory_read_policy$
DECLARE signature text;definition text;before text;
BEGIN
 FOREACH signature IN ARRAY ARRAY['application_memory_field_state_before_successor(uuid,uuid,text[])',
  'application_memory_historical_field_state(uuid,uuid,text[])'] LOOP
  definition:=pg_get_functiondef(signature::regprocedure);
  before:=$before$'policyVersion',application_field_digest(jsonb_build_object('kind','memory-fields-v1','catalog',context#>'{policy,fingerprint}','record',policy->'fingerprint','mask',mask))$before$;
  IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory READ policy prerequisite changed: %',signature;END IF;
  definition:=replace(definition,before,$after$'legacyPolicyVersion',application_field_digest(jsonb_build_object('kind','memory-fields-v1','catalog',context#>'{policy,fingerprint}','record',policy->'fingerprint','mask',mask)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','memory-read-v2','catalog',context#>'{policy,fingerprint}','record',policy->'fingerprint','selectedRead',jsonb_build_object('fields',fields,'allowed',true)))$after$);
  EXECUTE definition;
 END LOOP;
END $memory_read_policy$;

-- These are the canonical validators and their existing same-statement clone.
-- Only native Memory can use the exact freshly recomputed legacy digest.
DO $memory_recorded_policy$
DECLARE signature text;definition text;before text;
BEGIN
 FOREACH signature IN ARRAY ARRAY['application_recorded_field_state_before_record_ancestry(uuid,uuid,text,integer)',
  'application_recorded_field_root_capture(uuid,uuid,text,integer)'] LOOP
  definition:=pg_get_functiondef(signature::regprocedure);
  before:=$before$current#>>'{state,policyVersion}' IS DISTINCT FROM observation.policy_version$before$;
  IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory recorded policy prerequisite changed: %',signature;END IF;
  definition:=replace(definition,before,$after$(current#>>'{state,policyVersion}' IS DISTINCT FROM observation.policy_version
   AND NOT coalesce(resource.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND resource.type_key='memory'
    AND current#>>'{state,legacyPolicyVersion}'=observation.policy_version,false))$after$);
  EXECUTE definition;
 END LOOP;
 FOREACH signature IN ARRAY ARRAY['application_session_eval_field(uuid,uuid,text,jsonb)',
  'application_canonical_ancestry_from_admitted_root(uuid,text,uuid,text,boolean,jsonb)'] LOOP
  definition:=pg_get_functiondef(signature::regprocedure);
  before:=$before$envelope#>>'{state,policyVersion}' IS DISTINCT FROM observation.policy_version$before$;
  IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory envelope policy prerequisite changed: %',signature;END IF;
  definition:=replace(definition,before,$after$(envelope#>>'{state,policyVersion}' IS DISTINCT FROM observation.policy_version
   AND NOT coalesce(resource.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND resource.type_key='memory'
    AND envelope#>>'{state,legacyPolicyVersion}'=observation.policy_version,false))$after$);
  EXECUTE definition;
 END LOOP;
END $memory_recorded_policy$;

-- New domains capture READ-only policies. Original domains retain their exact
-- stored policy when, and only when, current canonical legacy recomputation agrees.
-- The outer domain evaluator still checks the entire original cohort and policies.
DO $memory_query_policy$
DECLARE definition text;before text;
BEGIN
 definition:=pg_get_functiondef('application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb)'::regprocedure);
 before:=$before$policies:=policies||jsonb_build_array(jsonb_build_object('id',candidate.id,'policy',state->'policyVersion'));$before$;
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory query policy prerequisite changed';END IF;
 definition:=replace(definition,before,$after$policies:=policies||jsonb_build_array(jsonb_build_object('id',candidate.id,'policy',
   CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(frozen->'policies') original_policy
    WHERE original_policy->>'id'=candidate.id::text AND original_policy->'policy'=state->'legacyPolicyVersion')
   THEN state->'legacyPolicyVersion' ELSE state->'policyVersion' END));$after$);
 EXECUTE definition;
END $memory_query_policy$;
COMMIT;
