// [COMP:api/migration-execution-sql] Authenticate commutative literal pin lists.
// Historical installers sorted VALUES by local OID, then 8269 replaced retired
// guard IDs in place. Compare source-owned multisets at admission, but retain
// the original installer's authored output order for later source compilers.
export function publicationPinOrderingExecutionSql(sql: string): string {
  const profiles = [
    ['application_empty_query_helpers_current()', 4],
    ['application_native_context_fields_current()', 3],
    ['application_native_file_capture_helpers_current()', 7],
    ['application_native_title_acquisition_helpers_current()', 8],
    ['application_native_title_group_helpers_current()', 7],
    ['application_native_worklist_helpers_current()', 85],
  ] as const
  const declaration = " FOR expected IN SELECT value FROM jsonb_array_elements('"
  const sections = sql.split(declaration)
  const source = sections[1]?.match(/^((?:''|[^'])*)'::jsonb/)
  if (sections.length !== 2 || !source) throw new Error('8272: pin ordering source boundary changed')
  const contracts = JSON.parse(source[1].replaceAll("''", "'")) as {
    signature: string; bodyParts: (string | { slot: { kind: string; identity: string } })[]
  }[]
  for (const [signature, count] of profiles) {
    const parts = contracts.find(contract => contract.signature === signature)?.bodyParts
    const slots = parts?.filter(part => typeof part !== 'string')
    const text = parts?.map(part => typeof part === 'string' ? part : '?').join('')
    const aggregate = `count(*)=${count} AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')=pin.fingerprint),false)`
    if (!text?.includes(aggregate) || slots?.length !== count * 2
      || slots.some((part, index) => part.slot.kind !== (index % 2 ? 'fingerprint' : 'function')
        || index % 2 === 1 && part.slot.identity !== slots[index - 1].slot.identity)) {
      throw new Error(`8272: pin ordering profile changed: ${signature}`)
    }
  }
  const once = (before: string, after: string) => {
    if (sql.split(before).length !== 2) throw new Error('8272: pin ordering execution boundary changed')
    sql = sql.replace(before, after)
  }
  const signatures = profiles.map(([signature]) => `'${signature}'`).join(',')
  const consumers = [...contracts.map(contract => contract.signature),
    'record_admitted_application_field_derivation(uuid,text,uuid,text,text,jsonb)']
    .map(signature => `'${signature.replaceAll("'", "''")}'`).join(',')
  const functions = `-- Only six reviewed hash/count guards have commutative literal VALUES rows.
-- Tuple values, multiplicities, surrounding code, metadata and ACLs stay exact.
-- Never execute installed bodies or use their pins to supply expected values.
CREATE FUNCTION pg_temp.publication_pin_normalize(routine text,body text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $pin_order$
DECLARE blocks text[];rows text;ordered text;remainder text;members integer;
BEGIN
 IF routine<>ALL(ARRAY[${signatures}]::text[]) THEN RETURN body;END IF;
 SELECT array_agg(parsed.captures[1]) INTO blocks FROM regexp_matches(body,
  $pin_block$FROM \\(VALUES (.*?)\\) pin\\(function_oid,fingerprint\\) JOIN pg_catalog\\.pg_proc p ON p\\.oid=pin\\.function_oid$pin_block$,'g') parsed(captures);
 IF cardinality(blocks) IS DISTINCT FROM 1 THEN RETURN body;END IF;
 rows:=blocks[1];
 SELECT count(*),string_agg(format('(%s::oid,%L::text)',parsed.captures[1]::oid,parsed.captures[2]),',' ORDER BY parsed.captures[1]::oid,parsed.captures[2] COLLATE "C")
 INTO members,ordered FROM regexp_matches(rows,$pin_tuple$\\((0|[1-9][0-9]*)::oid,'([a-f0-9]{64})'::text\\)$pin_tuple$,'g') parsed(captures);
 remainder:=regexp_replace(rows,$pin_tuple$\\((0|[1-9][0-9]*)::oid,'([a-f0-9]{64})'::text\\)$pin_tuple$,'','g');
 IF members=0 OR remainder IS DISTINCT FROM repeat(',',members-1)
  OR (length(body)-length(replace(body,rows,'')))/length(rows)<>1 THEN RETURN body;END IF;
 RETURN replace(body,rows,ordered);
END $pin_order$;
CREATE FUNCTION pg_temp.publication_pin_body_matches(routine text,actual text,expected text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $pin_compare$
 SELECT (pg_temp.publication_pin_normalize(routine,actual) COLLATE "C")
  IS NOT DISTINCT FROM (pg_temp.publication_pin_normalize(routine,expected) COLLATE "C")
$pin_compare$;
-- The upstream bridge precedes the normal installer's consumer classification.
-- Refuse unknown consumers of the original fingerprint before any body rewrite.
CREATE FUNCTION pg_temp.publication_pin_assert_consumers(original pg_catalog.pg_proc) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $pin_consumers$
DECLARE caller record;old_hash text:=encode(sha256(convert_to(to_jsonb(original)::text,'UTF8')),'hex');
 approved constant text[]:=ARRAY[${consumers}]::text[];
BEGIN
 FOR caller IN SELECT p.oid,p.oid::regprocedure::text signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname!~'^pg_(temp|toast)' AND strpos(p.prosrc,old_hash)>0 LOOP
  IF NOT EXISTS(SELECT 1 FROM unnest(approved) signature WHERE caller.oid=to_regprocedure('public.'||signature)::oid)
  THEN RAISE EXCEPTION 'publication_unreviewed_upstream_pin_consumer: %',caller.signature;END IF;
 END LOOP;
END $pin_consumers$;
`
  const compiler = 'CREATE FUNCTION pg_temp.publication_source_body('
  once(compiler, functions + compiler)
  once('(p.prosrc COLLATE "C") IS DISTINCT FROM (body COLLATE "C")\n   OR (to_jsonb(p)',
    "pg_temp.publication_pin_body_matches(expected->>'signature',p.prosrc,body) IS NOT TRUE\n   OR (to_jsonb(p)")
  once("ELSIF p.prosrc IS DISTINCT FROM pg_temp.publication_source_body(signature,expected->'bodyParts',false) THEN",
    "ELSIF pg_temp.publication_pin_body_matches(signature,p.prosrc,pg_temp.publication_source_body(signature,expected->'bodyParts',false)) IS NOT TRUE THEN")
  once('  IF body IS NOT DISTINCT FROM original.prosrc THEN CONTINUE;END IF;\n  definition:=pg_get_functiondef(original.oid);',
    '  IF body IS NOT DISTINCT FROM original.prosrc THEN CONTINUE;END IF;\n  PERFORM pg_temp.publication_pin_assert_consumers(original);\n  definition:=pg_get_functiondef(original.oid);')
  return sql
}
