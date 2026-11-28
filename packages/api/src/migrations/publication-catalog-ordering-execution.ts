// [COMP:api/migration-execution-sql] Preserve historical local-OID catalog ordering.
// Called only after execution-sql.ts authenticates each immutable source.
type PublicationPrefix = '' | `${'a' | 'c'}${number}_`

export function publicationCatalogOrderingExecutionSql(sql: string, prefix: PublicationPrefix = ''): string {
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
    snapshotCall = `INSERT INTO ${prefix.startsWith('a') ? 'pg_temp.' : ''}${prefix}publication_predecessor_table_snapshot SELECT pg_temp.${prefix}publication_json(`
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
  // Conversion and copied successor installers also compare the independently
  // declared pre-installer table snapshot outside a catalogLiteral body slot.
  if (snapshotCall) sql = sql.replace(snapshotCall,
    snapshotCall.replace(`${prefix}publication_json(`, `${prefix}publication_ordered_catalog(`))
  if (prefix.startsWith('a')) {
    // Several later migrations reuse a8314_. Keep the new temporary renderer in
    // the source-owned cleanup roster, just like the original compiler helpers.
    const cleanup = `p.proname=ANY(ARRAY['${prefix}publication_default_profile_boolean_false'`
    if (sql.split(cleanup).length !== 2) throw new Error('publication: catalog ordering cleanup boundary changed')
    sql = sql.replace(cleanup, cleanup.replace('ARRAY[', `ARRAY['${prefix}publication_ordered_catalog',`))
  }
  return sql
}

// Reviewed copies of the conversion compiler. Each still renders the original
// FK relation snapshot, even after trigger snapshots become literal body parts.
// Authenticate immutable bytes before adapting a copy, including installers that
// also need another execution-only compatibility adaptation.
export const publicationCatalogOrderingSuccessors: Readonly<Record<string, readonly [string, PublicationPrefix]>> = {
  '8276_registry_guard_successor.sql': ['e3fa2d4c7c7b5d2079d88dd48dc6a6d6f8e200bb961e912020bebeb381cb1849', 'a8274_'],
  '8277_durable_turn_completions.sql': ['9531458b8f0dcce872f2debff5efdda58ac898a5793d48bd147e2bfe54b77aaa', 'a8276_'],
  '8278_page_closure_adapter.sql': ['9fa28fcbb7aa3c2654c1c2a097512cc79beb2e6062bbc759d397241985722920', 'a8277_'],
  '8280_query_domain_visibility.sql': ['f27960cfbf5bc9b22cefd1c2b7627008a2ec2b2d52d0dd57ea2a0d375f1bc75c', 'a8278_'],
  '8281_private_transcript_floor.sql': ['7b30be0c4ddcf68b285c9aea9bdc259da8d5608b5fd1e07ded94d38660f46fb7', 'a8280_'],
  '82860_legacy_title_admission_privilege_order.sql': ['9182fe523bcb1ad49590ded76776e30d578d315ba29ae7d1c990aa51c84e4193', 'a8281_'],
  '8286_title_revision_admission.sql': ['c601a5145d310b8381c69b88958f8c1f54215805d2c95761ff5ad09afae9c2f7', 'a8281_'],
  '8287_page_closure_roots.sql': ['2ff9c8b66980f573279aa2e01db49bd802e86e53074569bc49717346bce42ff4', 'a8286_'],
  '8289_fused_admission.sql': ['d0566b58861ffd12bfe4d1a2b91d4a80aaccae5a7d8abba7ca2af9b8186876b0', 'a8287_'],
  '8290_participation_read_retirement.sql': ['5fdaec0ab2468bc805c7163478d58e88b5c407efbc02a55fafdb5dc89a74b8d0', 'a8289_'],
  '8294_fused_admission_plan_size.sql': ['6107a119ebd420c92e1c8320249ad17453e9de2a0fbd82a65496c4748c9bbf20', 'a8290_'],
  '8296_configured_task_publication.sql': ['55b915bd94214f96266e6da94165f454361d9351dc82d6dab537137b507d2baf', 'a8294_'],
  '8297_conversation_record_admission.sql': ['c7dde30c0cefe61167be20492cb0df68a587c26352314e3dfab794ded77c4bf7', 'a8296_'],
  '8298_legacy_bypass_retirement.sql': ['e0dba38f73b1ebdefaeab8d9bf53b77f5a041451365faef872646444b909fefd', 'a8297_'],
  '8300_conversation_record_conversion.sql': ['529b96787bf97fdb04b51332de7d27f91e60830221b816348b7a9e4a49ead8cb', 'a8298_'],
  '8301_conversation_receiving_owners.sql': ['b4a4b960eb6c887427a93b8a930eca39ec1ad8bef89e73ba1e0df3b34fff31c6', 'a8300_'],
  '8306_conversation_prompt_memory.sql': ['34837278c15d8f5db8a0ee8bd87b3076923ae5112107dfea4fd6c2b5214586cf', 'a8301_'],
  '8307_conversation_record_floor.sql': ['e4b28848c1098f2cf04d78ba52f943ed5f44aae001d286c80d6b1142a80555b8', 'a8306_'],
  '8309_conversation_record_lineage.sql': ['c81d6dd7992215e0e009951d81a4606ec6fdf879d60314a3173b5848a09a7264', 'a8307_'],
  '8310_conversation_public_receiving.sql': ['2b641c4fe17c8aa5b821f22da1774d151e0b8eaa79e57ecf8a9ffd80d1abf4ac', 'a8309_'],
  '8311_conversation_page_delivery.sql': ['945bf1137d8c38cbcde5d98454f3f015f51b25566d737df11f1932be482b05c7', 'a8310_'],
  '8312_conversation_verified_channel_publication.sql': ['47cd8a1a3abc1bee5bf859ec92d54e8126b8c222da211bffe37d67a28aa431cb', 'a8311_'],
  '8313_conversation_page_publication.sql': ['66f7ac2d26ed9dd627b41d5febff5ca4b05980abf349429433cfefbd17a00cee', 'a8312_'],
  '8314_conversation_settings_readiness.sql': ['194f272258aa1e96c3809e69ab952c96bdb5f9245f3bcb3738cd836620938cd3', 'a8313_'],
  '8315_conversation_retained_row_transitions.sql': ['b1d81d3c5be08f3013c1c11917478c299c5ab90bcc7fc75c3e5a6c45921c8aa4', 'a8314_'],
  '8316_conversation_mixed_evidence_route.sql': ['331e0dd17c7c91ddf96c8f0cb176e6aacdc55a4c6c1b90a09cb9328624f962e7', 'a8314_'],
  '8318_committed_room_record_evidence.sql': ['3621ed1c41321c113ad4ab77b6b9396e1348a73b0e02dca22189c5b08d28cceb', 'a8314_'],
  '8323_verified_telegram_conversation_evidence.sql': ['bbf88004e5217d2e76334befaadaad780c0f901f9a831f395c2cc2034a9f7940', 'a8314_'],
  '8325_conversation_office_observation.sql': ['a7db1e872ecf75591b97c59a29ce35fab53f255a03f094d1cd16d529e008127e', 'a8314_'],
  '8326_native_memory_query_write_contract.sql': ['c3a07b8c572088697a353179806f8cb880cfc73838094a2d3c2670c0a6aec269', 'a8314_'],
  '8327_conversation_graph_set_verification.sql': ['d83aede27f334594c52b405cf5418f561f7162346b3525c27295e8d2c240b844', 'a8314_'],
  '8328_conversation_graph_frontier.sql': ['d765163c179669642dd1ee533e79a36f64b2ab6bf537fcb20a3b89acccc81033', 'a8314_'],
  '8329_conversation_memory_query_candidates.sql': ['8fa9f3984bf71befa50e0da9c7207d1121857dca1a988188e51499cd78bc3104', 'a8314_'],
  '8332_conversation_context_cost.sql': ['3c6bff07e868ba480666b15357ffb75e090b6d6d2fb83b2b2e35e5e4cac42a51', 'a8314_'],
  '8334_conversation_publication_lock.sql': ['36da90d5c739e90c469e9d06d79e968d343887328e9aa46ba82dd5665ab2c300', 'a8314_'],
  '8338_native_workspace_skill_receipts.sql': ['568a021b968d42883bf8d67ac8d15d3fb8cf5a269d7874fec3c478cbd4f94dfd', 'a8314_'],
}
