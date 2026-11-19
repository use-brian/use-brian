// [COMP:api/migration-execution-sql] Authenticated upstream Memory 8268 transition.
export const memoryPublicationMigration = '8272_durable_conversation_publications.sql'
export const memoryPublicationSourceSha256 = '06afd49b1e8a165f8cee9ec78ee5c4fa42ef815cdbfd192fa77f453025451609'
export const memoryWriteSuccessorMigration = '8326_native_memory_query_write_contract.sql'
export const upstreamMemoryMigration = '8268_native_memory_query_write_lineage.sql'

// The exact difference between the two installed predecessor profiles. Order
// dependencies before consumers when re-rendering their source fingerprints.
const nativeMemoryContracts = [
  "application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb)",
  "native_turn_helpers_current()",
  "application_native_context_fields_current()",
  "application_native_worklist_helpers_current()",
  "capture_conversation_evidence(uuid,jsonb,jsonb,jsonb)",
  "capture_conversation_query(uuid,uuid,integer,integer)",
  "native_turn_publication_contract()",
  "publish_native_session_context_revision(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer)",
  "read_native_session_field_dependencies(uuid,text[],uuid[],text[])",
  "native_turn_capture_event(jsonb)",
  "native_turn_field_reference(uuid,uuid,uuid,text)",
  "native_turn_guard_completion_debt()",
  "native_turn_page_event(jsonb)",
  "native_turn_validate_event(jsonb)",
  "read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)",
  "read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)",
  "application_native_file_capture_helpers_current()",
  "application_native_title_group_helpers_current()",
  "native_turn_capture_event()",
  "validate_application_field_dependencies()",
  "validate_page_derivation_dependencies()",
  "validate_scope_resource_reference()",
  "application_native_title_acquisition_helpers_current()",
  "capture_native_session_query_stage(uuid,uuid,integer,text,jsonb,jsonb)",
  "read_native_personal_title_group_evidence(uuid,uuid[],uuid[])"
] as const
const scan = nativeMemoryContracts[0]
const writer = "record_admitted_application_field_derivation(uuid,text,uuid,text,text,jsonb)"
const ownedMemoryBodies = {
  "application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb)": [
    "1f5afc1d54fb3bbb09a9719cbc0b4d6b2bcd6cb5743df2143abc5abb7700a864",
    "fc0eb35e01aa364049649bd9d1bbf13ae6515ef6795d59db809d7e5aaf01c4f2"
  ],
  "record_admitted_application_field_derivation(uuid,text,uuid,text,text,jsonb)": [
    "ad277d20b255862745d1509c40a358b30cdff08dd1169591683018ebaacb7dde",
    "e09717426c463f354ee9491681bb80f7f51bc5a1d935e635368b56b4f273d6b4"
  ]
}
const canonicalWriterMetadata = {
  "probin": null,
  "procost": 100,
  "prokind": "f",
  "proname": "record_admitted_application_field_derivation",
  "prorows": 0,
  "pronargs": 6,
  "proconfig": [
    "search_path=pg_catalog, public, pg_temp"
  ],
  "proretset": false,
  "prosecdef": true,
  "prorettype": "2950",
  "prosqlbody": null,
  "prosupport": "-",
  "proargmodes": null,
  "proargnames": [
    "w",
    "k",
    "i",
    "v",
    "producer",
    "sources"
  ],
  "proargtypes": [
    "2950",
    "25",
    "2950",
    "25",
    "25",
    "3802"
  ],
  "proisstrict": false,
  "proparallel": "u",
  "protrftypes": null,
  "provariadic": "0",
  "provolatile": "v",
  "proleakproof": false,
  "proallargtypes": null,
  "proargdefaults": null,
  "pronargdefaults": 0,
  "prolang": {
    "$slot": {
      "kind": "language",
      "identity": "plpgsql",
      "encoding": "string"
    }
  },
  "pronamespace": {
    "$slot": {
      "kind": "namespace",
      "identity": "public",
      "encoding": "string"
    }
  },
  "proowner": {
    "$slot": {
      "kind": "owner",
      "identity": "OWNER",
      "encoding": "string"
    }
  }
}

/** Keep raw historical SQL immutable and commit the bridge with its original installer. */
export function memoryLineagePublicationExecutionSql(sql: string): string {
  const anchor = 'DO $authenticate$ DECLARE expected jsonb;'
  const declaration = " FOR expected IN SELECT value FROM jsonb_array_elements('"
  const ending = "'::jsonb) LOOP\n  SELECT * INTO p FROM pg_proc"
  const parts = sql.split(anchor)
  const registry = parts[1]?.split(declaration)[1]?.split(ending)[0]
  if (parts.length !== 2 || !registry) throw new Error('8272: publication source boundary changed')
  const contracts = JSON.parse(registry.replaceAll("''", "'")) as { signature: string }[]
  const affected = [...nativeMemoryContracts, 'crm_capture_erasure_effect()'].map(signature => {
    const contract = contracts.find(item => item.signature === signature)
    if (!contract) throw new Error(`8272: missing source projection for ${signature}`)
    return contract
  })
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
  const value = (input: unknown) => `${literal(JSON.stringify(input))}::jsonb`
  const source = `
-- The original 8268 is retained byte-for-byte at scripts/conversation-store/historical.
-- The canonical publication installer below authenticates every normal predecessor
-- after this exact upstream variant has been reconciled inside its transaction.
DO $memory_upstream$
DECLARE owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);
 runtime_id oid:=(SELECT oid FROM pg_roles WHERE rolname='app_user');
 expected jsonb; acl jsonb; p pg_proc; body text; definition text; source text; profile jsonb;
 registry pg_class; signature text; original pg_proc; snapshot record;
 writer_stage text; writer_lineage text;
 capture_setting text:=current_setting('app.crm_erasure_capture',true);
 writer_insert constant text:=' INSERT INTO workspace_access_policies(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;';
 writer_source_loop constant text:=E'\\n FOR source IN SELECT value FROM jsonb_array_elements(sources) ORDER BY value->>''resourceKind'',value->>''resourceId'' LOOP';
 writer_return constant text:=E'\\n RETURN derivation;';
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name=${literal(upstreamMemoryMigration)}) THEN
  RETURN;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='8271_refresh_recovery_capture.sql')
  OR to_regclass('public.native_memory_query_write_intents') IS NULL
 THEN RAISE EXCEPTION 'publication_upstream_memory_receipt_changed';END IF;
 SELECT * INTO registry FROM pg_class WHERE oid=to_regclass('public.native_turn_contract_helpers');
 IF registry.oid IS NULL OR registry.relowner<>owner_id OR registry.relkind<>'r' OR registry.relpersistence<>'p'
  OR NOT registry.relrowsecurity OR registry.relforcerowsecurity
  OR coalesce(registry.relacl,acldefault('r',owner_id)) IS DISTINCT FROM acldefault('r',owner_id)
  OR EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=registry.oid)
  OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=registry.oid)
  OR (SELECT count(*) FROM pg_trigger WHERE tgrelid=registry.oid)<>1
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=registry.oid AND tgname='crm_recovery_capture'
    AND tgfoid='public.crm_capture_erasure_effect()'::regprocedure AND tgenabled='O'
    AND tgtype=29 AND NOT tgisinternal AND tgconstraint=0 AND tgparentid=0 AND tgconstrrelid=0 AND tgconstrindid=0
    AND NOT tgdeferrable AND NOT tginitdeferred AND tgnargs=0 AND octet_length(tgargs)=0
    AND pg_get_expr(tgqual,tgrelid) IS NULL AND tgattr::text='' AND tgoldtable IS NULL AND tgnewtable IS NULL)
  OR (SELECT jsonb_agg(jsonb_build_array(attname,atttypid::text,attnotnull,attgenerated,attidentity,attacl) ORDER BY attnum)
      FROM pg_attribute WHERE attrelid=registry.oid AND attnum>0 AND NOT attisdropped)
     IS DISTINCT FROM jsonb_build_array(jsonb_build_array('signature','25',true,'','',NULL),
      jsonb_build_array('contract','pg_catalog.pg_proc'::regtype::oid::text,true,'','',NULL))
 THEN RAISE EXCEPTION 'publication_upstream_memory_registry_changed';END IF;
 CREATE TEMP TABLE publication_upstream_memory_sources(signature text PRIMARY KEY,profile jsonb NOT NULL,original pg_proc NOT NULL) ON COMMIT DROP;
 FOR expected IN SELECT element FROM jsonb_array_elements(${value(affected)}) element LOOP
  signature:=expected->>'signature';
  SELECT * INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure('public.'||signature);
  IF p.proowner<>owner_id OR (to_jsonb(p)-ARRAY['oid','prosrc','proacl']) IS DISTINCT FROM pg_temp.publication_json(expected->'metadata')
  THEN RAISE EXCEPTION 'publication_upstream_memory_metadata_changed: %',signature;END IF;
  SELECT jsonb_agg(jsonb_build_object('grantee',grantee,'grantor',grantor,'privilege',privilege,'grantable',grantable) ORDER BY grantee COLLATE "C") INTO acl
   FROM(SELECT CASE WHEN a.grantee=p.proowner THEN 'OWNER' WHEN a.grantee=0 THEN 'PUBLIC' WHEN a.grantee=runtime_id THEN 'app_user' ELSE 'UNREVIEWED' END grantee,
    CASE WHEN a.grantor=p.proowner THEN 'OWNER' ELSE 'UNREVIEWED' END grantor,a.privilege_type privilege,a.is_grantable grantable
    FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a) grants;
  IF acl IS DISTINCT FROM expected->'acl' THEN RAISE EXCEPTION 'publication_upstream_memory_acl_changed: %',signature;END IF;
  IF signature=${literal(scan)} THEN
   IF encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')<>${literal(ownedMemoryBodies[scan][1])}
   THEN RAISE EXCEPTION 'publication_upstream_memory_body_changed: %',signature;END IF;
  ELSIF p.prosrc IS DISTINCT FROM pg_temp.publication_source_body(signature,expected->'bodyParts',false) THEN
   RAISE EXCEPTION 'publication_upstream_memory_body_changed: %',signature;
  END IF;
  INSERT INTO pg_temp.publication_upstream_memory_sources VALUES(signature,expected,p);
 END LOOP;
 SELECT * INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure(${literal('public.' + writer)});
 IF p.proowner<>owner_id
  OR (to_jsonb(p)-ARRAY['oid','prosrc','proacl']) IS DISTINCT FROM pg_temp.publication_json(${value(canonicalWriterMetadata)})
  OR (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.grantee) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)
   IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.grantee) FROM aclexplode(ARRAY[
    makeaclitem(owner_id,owner_id,'EXECUTE',false),makeaclitem(runtime_id,owner_id,'EXECUTE',false)]) a)
  OR encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')<>${literal(ownedMemoryBodies[writer][1])}
 THEN RAISE EXCEPTION 'publication_upstream_memory_body_changed: %',${literal(writer)};END IF;
 INSERT INTO pg_temp.publication_upstream_memory_sources VALUES(${literal(writer)},'{}'::jsonb,p);
 IF EXISTS(SELECT 1 FROM public.native_turn_contract_helpers h JOIN pg_temp.publication_upstream_memory_sources s USING(signature)
           WHERE h.contract IS DISTINCT FROM s.original)
 THEN RAISE EXCEPTION 'publication_upstream_memory_registry_record_changed';END IF;
 -- Registry body repins are installation metadata, not replayable data edits.
 PERFORM set_config('app.crm_erasure_capture','off',true);
 -- Only the reviewed historical bodies can change. Fingerprints are rendered
 -- from the new local OIDs, preserving the exact source metadata and ACLs.
 FOR source IN SELECT item FROM unnest(ARRAY[${[writer, ...nativeMemoryContracts].map(literal).join(',')}]) WITH ORDINALITY x(item,rank) ORDER BY rank LOOP
  SELECT s.profile,s.original INTO STRICT snapshot FROM pg_temp.publication_upstream_memory_sources s WHERE s.signature=source;
  profile:=snapshot.profile;
  original:=snapshot.original;
  IF source=${literal(writer)} THEN
   -- Invert the published, authenticated stage move. Its original branch
   -- inserts the same durable edges after the source-validation loop.
   writer_stage:=substring(original.prosrc FROM strpos(original.prosrc,writer_insert)
    FOR strpos(original.prosrc,writer_source_loop)-strpos(original.prosrc,writer_insert));
   writer_lineage:=substring(writer_stage FROM 1 FOR strpos(writer_stage,' INSERT INTO native_memory_query_write_intents(')-1)
    ||substring(writer_stage FROM strpos(writer_stage,' INSERT INTO scope_derivation_sources('));
   writer_lineage:=replace(writer_lineage,E'\\n DELETE FROM native_memory_query_write_intents WHERE derivation_id=derivation AND transaction_id=pg_current_xact_id_if_assigned();','');
   body:=replace(replace(original.prosrc,writer_stage||E'\\n',''),E'\\n'||writer_return,E'\\n'||writer_lineage||writer_return);
   IF encode(sha256(convert_to(body,'UTF8')),'hex')<>${literal(ownedMemoryBodies[writer][0])}
   THEN RAISE EXCEPTION 'publication_upstream_memory_canonical_writer_changed';END IF;
  ELSE
   body:=pg_temp.publication_source_body(source,profile->'bodyParts',false);
   IF source=${literal(scan)} AND encode(sha256(convert_to(body,'UTF8')),'hex')<>${literal(ownedMemoryBodies[scan][0])}
   THEN RAISE EXCEPTION 'publication_upstream_memory_canonical_scan_changed';END IF;
  END IF;
  IF body IS NOT DISTINCT FROM original.prosrc THEN CONTINUE;END IF;
  definition:=pg_get_functiondef(original.oid);
  IF (length(definition)-length(replace(definition,original.prosrc,'')))/length(original.prosrc)<>1
  THEN RAISE EXCEPTION 'publication_upstream_memory_declaration_changed: %',source;END IF;
  EXECUTE replace(definition,original.prosrc,body);
  SELECT * INTO STRICT p FROM pg_proc WHERE oid=original.oid;
  IF p.prosrc IS DISTINCT FROM body OR (to_jsonb(p)-'prosrc') IS DISTINCT FROM (to_jsonb(original)-'prosrc')
  THEN RAISE EXCEPTION 'publication_upstream_memory_successor_changed: %',source;END IF;
  UPDATE public.native_turn_contract_helpers h SET contract=p WHERE h.signature=source;
 END LOOP;
 PERFORM set_config('app.crm_erasure_capture',coalesce(capture_setting,''),true);
END $memory_upstream$;
`
  return `${parts[0]}${source}${anchor}${parts[1]}`
}
