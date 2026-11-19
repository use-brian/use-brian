-- [COMP:api/native-turn-frame] Classify ORIGINAL pin consumers before enrollment.
CREATE TEMP TABLE conversion_affected_functions(signature text PRIMARY KEY,original_fingerprint text NOT NULL) ON COMMIT DROP;
INSERT INTO conversion_affected_functions SELECT signature,encode(sha256(convert_to(metadata::text,'UTF8')),'hex')
 FROM publication_expected_current WHERE signature IN('native_turn_helpers_current()','native_turn_publication_contract()');
DO $conversion_original_consumers$
DECLARE changes integer;passes integer:=0;unknown text;
BEGIN
 LOOP
  passes:=passes+1;IF passes>100 THEN RAISE EXCEPTION 'conversion_pin_cycle';END IF;
  INSERT INTO conversion_affected_functions
   SELECT e.signature,encode(sha256(convert_to(e.metadata::text,'UTF8')),'hex') FROM publication_expected_current e
   WHERE NOT EXISTS(SELECT 1 FROM conversion_affected_functions a WHERE a.signature=e.signature)
   AND EXISTS(SELECT 1 FROM conversion_affected_functions a WHERE strpos(e.metadata->>'prosrc',a.original_fingerprint)>0);
  GET DIAGNOSTICS changes=ROW_COUNT;EXIT WHEN changes=0;
 END LOOP;
 SELECT c.oid::regprocedure::text INTO unknown FROM pg_proc c JOIN pg_namespace n ON n.oid=c.pronamespace
 WHERE c.pronamespace<>pg_my_temp_schema() AND NOT pg_is_other_temp_schema(c.pronamespace)
  AND n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname!~'^pg_toast'
  AND EXISTS(SELECT 1 FROM conversion_affected_functions a WHERE strpos(c.prosrc,a.original_fingerprint)>0)
  AND NOT EXISTS(SELECT 1 FROM publication_successor_templates t WHERE t.signature=c.oid::regprocedure::text)
 LIMIT 1;
 IF unknown IS NOT NULL THEN RAISE EXCEPTION 'conversion_unreviewed_original_pin_consumer: %',unknown;END IF;
END $conversion_original_consumers$;
