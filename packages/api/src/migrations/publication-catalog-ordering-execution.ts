// [COMP:api/migration-execution-sql] Preserve historical local-OID catalog ordering.
// Called only after execution-sql.ts authenticates each immutable source.
export function publicationCatalogOrderingExecutionSql(sql: string, prefix: '' | 'c8273_' | 'a8273_' = ''): string {
  type Part = string | { slot: { kind: string; template: unknown } }
  const template = (parts: Part[], index: number) => {
    const part = parts[index]
    if (!part || typeof part === 'string' || part.slot.kind !== 'catalogLiteral') {
      throw new Error(`publication: missing catalog ordering template: ${prefix}/${index}`)
    }
    return part.slot.template
  }
  const sourceLiteral = (anchor: string): unknown => {
    if (sql.split(anchor).length !== 2) throw new Error('publication: catalog ordering source boundary changed')
    const match = sql.split(anchor)[1].match(/^((?:''|[^'])*)'::jsonb/)
    if (!match) throw new Error('publication: catalog ordering source literal changed')
    return JSON.parse(match[1].replaceAll("''", "'"))
  }
  let guardParts: Part[]
  let tables: unknown
  let snapshotCall: string | undefined
  if (!prefix) {
    const contracts = sourceLiteral(" FOR expected IN SELECT value FROM jsonb_array_elements('") as {
      signature: string; bodyParts: Part[]
    }[]
    guardParts = contracts.find(contract => contract.signature === 'native_turn_helpers_current()')!.bodyParts
    tables = template(contracts.find(contract => contract.signature === 'native_turn_publication_contract()')!.bodyParts, 1)
  } else {
    const anchor = `CREATE FUNCTION pg_temp.${prefix}publication_source_body(`
    if (sql.split(anchor).length !== 2) throw new Error('publication: source ordering compiler boundary changed')
    const declaration = sql.split(anchor)[1].match(/DECLARE source_parts jsonb:='((?:''|[^'])*)'::jsonb;expected_parts jsonb;/)
    if (!declaration) throw new Error('publication: source ordering compiler declaration changed')
    guardParts = JSON.parse(declaration[1].replaceAll("''", "'"))
    snapshotCall = `INSERT INTO ${prefix === 'a8273_' ? 'pg_temp.' : ''}${prefix}publication_predecessor_table_snapshot SELECT pg_temp.${prefix}publication_json(`
    tables = sourceLiteral(snapshotCall + "'")
  }
  // These are the ORDER BY operations in the historical installers, not a
  // generic JSON normalization. In particular, ACLs, FK keys, argument arrays
  // and every other byte retain their independently reviewed ordering.
  const profiles = [
    { template: template(guardParts, 1), orders: [['', 'oid']] },
    { template: template(guardParts, 3), orders: [
      ['triggers', 'oid'], ['functions', 'oid'], ['relations', 'relation'], ['rules', 'oid'],
    ] },
    { template: tables, orders: [
      ['tables', 'oid'], ['columns', 'column'], ['defaults', 'oid'], ['policies', 'oid'],
      ['triggers', 'oid'], ['constraints', 'oid'], ['rules', 'oid'],
    ] },
  ]
  const literal = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`
  const anchor = `CREATE FUNCTION pg_temp.${prefix}publication_body(parts jsonb) RETURNS text`
  const call = `quote_literal(pg_temp.${prefix}publication_json(part#>'{slot,template}')::text)`
  if (sql.split(anchor).length !== 2 || sql.split(call).length !== 2) {
    throw new Error('publication: catalog ordering renderer boundary changed')
  }
  const renderer = `-- Re-render ONLY source-owned catalog arrays in their historical local-OID
-- order. No installed function body, registry row or catalog tuple supplies an
-- expected value; publication_json resolves the original reviewed slots only.
CREATE FUNCTION pg_temp.${prefix}publication_ordered_catalog(template jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $catalog_order$
DECLARE profiles constant jsonb:=${literal(profiles)};
 profile jsonb;ordering jsonb;rendered jsonb;items jsonb;ordered jsonb;key text;kind text;
BEGIN
 rendered:=pg_temp.${prefix}publication_json(template);
 FOR profile IN SELECT value FROM jsonb_array_elements(profiles) LOOP
  IF template IS DISTINCT FROM profile->'template' THEN CONTINUE;END IF;
  FOR ordering IN SELECT value FROM jsonb_array_elements(profile->'orders') LOOP
   key:=ordering->>0;kind:=ordering->>1;
   items:=CASE WHEN key='' THEN rendered ELSE rendered->key END;
   IF items='null'::jsonb THEN CONTINUE;END IF;
   IF jsonb_typeof(items) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'publication_catalog_ordering_shape_changed';END IF;
   IF kind='oid' THEN
    SELECT jsonb_agg(value ORDER BY (value->>'oid')::oid) INTO ordered FROM jsonb_array_elements(items);
   ELSIF kind='relation' THEN
    SELECT jsonb_agg(value ORDER BY (value->>0)::oid) INTO ordered FROM jsonb_array_elements(items);
   ELSIF kind='column' THEN
    SELECT jsonb_agg(value ORDER BY (value->>0)::oid,(value->>1)::integer) INTO ordered FROM jsonb_array_elements(items);
   ELSE RAISE EXCEPTION 'publication_catalog_ordering_profile_changed';END IF;
   ordered:=coalesce(ordered,'[]'::jsonb);
   rendered:=CASE WHEN key='' THEN ordered ELSE jsonb_set(rendered,ARRAY[key],ordered) END;
  END LOOP;
  RETURN rendered;
 END LOOP;
 RETURN rendered;
END $catalog_order$;
`
  sql = sql.replace(anchor, renderer + anchor).replace(call,
    `quote_literal(pg_temp.${prefix}publication_ordered_catalog(part#>'{slot,template}')::text)`)
  // 8273/8274 also compare the independently declared pre-installer table
  // snapshot directly, outside a catalogLiteral body slot.
  if (snapshotCall) sql = sql.replace(snapshotCall,
    snapshotCall.replace(`${prefix}publication_json(`, `${prefix}publication_ordered_catalog(`))
  return sql
}
