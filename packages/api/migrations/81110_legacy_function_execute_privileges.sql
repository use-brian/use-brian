BEGIN;
-- [COMP:api/migration-owner-role] Reconcile only reviewed historical function grants.
-- Name-sorted between 8110_ and 8111_; never rename an applied migration.
-- The original 8111 gate remains unchanged. Historical 269 granted app_user
-- EXECUTE by default, which a later REVOKE FROM PUBLIC does not remove.
DO $legacy_function_privileges$
DECLARE expected record;actual pg_proc;actual_acl text[];
 lineage_pins text;lineage_pin_count integer;
 owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass);
 runtime_id oid:=(SELECT oid FROM pg_roles WHERE rolname='app_user');
 legacy_default pg_default_acl; extra jsonb; repair_signatures text[]:='{}'; repair_signature text;
 reviewed_lineage_body CONSTANT text := $reviewed$
DECLARE nodes jsonb;
BEGIN
 IF kinds IS NULL OR ids IS NULL OR versions IS NULL
  OR cardinality(kinds) IS DISTINCT FROM cardinality(ids) OR cardinality(ids) IS DISTINCT FROM cardinality(versions)
  OR cardinality(ids) NOT BETWEEN 1 AND 100 OR array_position(kinds,NULL) IS NOT NULL
  OR array_position(ids,NULL) IS NOT NULL OR array_position(versions,NULL) IS NOT NULL THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023'; END IF;
 -- R2 canonical entity leaf transport, after the original complete input validation.
 IF w IS NOT NULL AND cardinality(ids)=1
  AND array_ndims(kinds)=1 AND array_lower(kinds,1)=1
  AND array_ndims(ids)=1 AND array_lower(ids,1)=1
  AND array_ndims(versions)=1 AND array_lower(versions,1)=1
  AND kinds[1] IN('entity','memory')
  AND NOT EXISTS(SELECT 1 FROM public.scope_derivations d
   WHERE d.workspace_id=w AND d.resource_kind=kinds[1] AND d.resource_id=ids[1])
  AND (kinds[1]='entity' AND NOT EXISTS(SELECT 1 FROM public.entities e
    WHERE e.workspace_id=w AND e.superseded_by=ids[1])
   OR kinds[1]='memory' AND NOT EXISTS(SELECT 1 FROM public.memories m
    WHERE m.workspace_id=w AND m.superseded_by=ids[1]))
  AND (SELECT count(*)=11 AND coalesce(bool_and(public.application_field_digest(jsonb_build_object('name',r.proname,'namespace',r.pronamespace,'body',r.prosrc,'config',r.proconfig,'language',r.prolang,'securityDefiner',r.prosecdef,'volatility',r.provolatile,'strict',r.proisstrict,'parallel',r.proparallel))=pin.fingerprint),false)
   FROM (VALUES %s) pin(function_oid,fingerprint)
   JOIN pg_catalog.pg_proc r ON r.oid=pin.function_oid) THEN
  RETURN QUERY SELECT kinds[1],ids[1],versions[1];
  RETURN;
 END IF;
 WITH RECURSIVE lineage(kind,id,version) AS (
  SELECT * FROM unnest(kinds,ids,versions)
  UNION
  SELECT next.kind,next.id,next.version FROM lineage l
   CROSS JOIN LATERAL application_scope_source_edges(w,l.kind,l.id,l.version) next
 ), bounded AS MATERIALIZED(SELECT * FROM lineage LIMIT 4097)
 SELECT coalesce(jsonb_agg(to_jsonb(b)),'[]') INTO nodes FROM bounded b;
 -- UNION terminates native high-water back-edges (including a row edited from
 -- its earlier version). New field-child graphs are separately depth bounded
 -- by capture and the admitted reader; no app role may author metadata edges.
 IF jsonb_array_length(nodes)>4096 OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n
  WHERE n->>'version' IS NULL OR n->>'kind' IS NULL OR n->>'id' IS NULL
   OR n->>'kind'='application_field' AND NOT EXISTS(SELECT 1 FROM application_field_observations o
    WHERE o.workspace_id=w AND o.resource_id=(n->>'id')::uuid AND o.version=n->>'version')) THEN
  RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='22023'; END IF;
 RETURN QUERY SELECT DISTINCT n->>'kind',(n->>'id')::uuid,n->>'version' FROM jsonb_array_elements(nodes) n;
END $reviewed$;
BEGIN
 IF runtime_id IS NULL THEN RETURN;END IF;
 -- Schema and global defaults are additive. A different/global inherited grant
 -- is not the known historical provisioning state and must not be normalized.
 IF EXISTS(SELECT 1 FROM pg_default_acl d,LATERAL aclexplode(d.defaclacl) a
  WHERE d.defaclrole=owner_id AND d.defaclobjtype='f' AND d.defaclnamespace=0 AND a.grantee=runtime_id) THEN
  RAISE EXCEPTION 'Legacy function default privileges changed: global grant';END IF;
 SELECT * INTO legacy_default FROM pg_default_acl
  WHERE defaclrole=owner_id AND defaclnamespace='public'::regnamespace AND defaclobjtype='f';
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM aclexplode(legacy_default.defaclacl) a WHERE a.grantee=runtime_id) THEN
  RETURN;
 END IF;
 IF owner_id IS DISTINCT FROM (SELECT oid FROM pg_roles WHERE rolname=current_user)
  OR (SELECT count(*) FROM aclexplode(legacy_default.defaclacl))<>1
  OR EXISTS(SELECT 1 FROM aclexplode(legacy_default.defaclacl) a
   WHERE a.grantee<>runtime_id OR a.grantor<>owner_id OR a.privilege_type<>'EXECUTE' OR a.is_grantable) THEN
  RAISE EXCEPTION 'Legacy function default privileges changed';END IF;
 IF EXISTS(SELECT 1 FROM public._migrations WHERE name='8111_native_memory_statement_visitor.sql')
  OR to_regprocedure('public.application_memory_statement_helpers_current()') IS NOT NULL THEN
  RAISE EXCEPTION 'Legacy function privileges require review: Memory guard already installed';END IF;
 FOR expected IN SELECT * FROM (VALUES
('public.application_session_eval_field(uuid,uuid,text,jsonb)','911015ce124bda696b6ba4d00ad4df4432e794c8dc2a336b62c3102b66b9b3e2',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.application_session_eval_envelope(uuid,text,uuid,text,text[],jsonb)','04c6a9c8b3975c1d7a83e4e325f222c7a7c114933bce10f0469dc8b901777078',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)','9456a5c799ccf3e45819cc445a183856d617729b511383a0ca1e263f40fe45f8',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.application_recorded_field_root_capture(uuid,uuid,text,integer)','78696ba056ff73545f82d396d04c88aeea43c464ea99935f782a7be364cea2c9',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.application_recorded_field_state_before_session_eval(uuid,uuid,text,integer)','f0b7e225262876625f4498a9e3857c9e14e7f8b8505a02b9c4042ef3c68f23be',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.application_canonical_ancestry_from_admitted_root(uuid,text,uuid,text,boolean,jsonb)','8e295f080c2b0840aa61fa00125698f2a2a208c648458778a8c42cf10b055849',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)','50973b8ff2d29e46ac9fdc0a424b8100d50ce28d3de6964eee52bde01cda43d7',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[])','8f5fded336342f24687b4dbd5f96020d0b5dfb86d645ae33346337eae6506f8c',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.application_memory_field_state(uuid,uuid,text[])','33935392a458a8948449a25ae575f6140578100718a044d305494f1da1f0e67b',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.application_memory_query_domain_state(uuid,uuid,text[])','a2d93f4c38c4e9de028561e592d930e5f41bf2487b7f98abeca9c474a1036550',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_admitted_native_scope_snapshot(uuid,text,uuid)','39740a78f8ad92ad04e7e0231cdb99402e4755471866a9e4526600208fce7b61',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['app_user','owner']::text[]),
('public.application_scope_lineage(uuid,text[],uuid[],text[])',NULL::text,ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.scope_review_state_held(text,uuid)','641bcd51d90f2d04beba35a2a0845008fe4900ef8bc2f4eea56330d058e5aca6',ARRAY['search_path=public, pg_temp']::text[],'sql',true,'s',false,'u',ARRAY['owner','public']::text[]),
('public.workflow_evidence_envelope_visible(uuid,jsonb)','8030f9dd8180adcacf17373a0b7ee10564a7016e20a42a647a3bc64df6974a61',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'s',false,'u',ARRAY['owner']::text[]),
('public.application_field_digest(jsonb)','e02b7a718d6279a47a7b9c1d5ad697702ed05cdc8467882329f89b80c6b9966b',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'sql',false,'i',true,'u',ARRAY['owner']::text[]),
('public.application_field_resource_uuid(text)','de0eb792a09c132c8133a2a026c204c3deb59ea430fe4c74a043d2102f9337ce',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'sql',false,'i',true,'u',ARRAY['owner']::text[]),
('public.entity_derivation_envelope_valid(jsonb)','11a923cfc5d1b5a76000dcfc40957316c3b2ca5dcd664b7a4b81de4b3188bc38',ARRAY['search_path=public, pg_temp']::text[],'plpgsql',false,'i',false,'u',ARRAY['owner']::text[]),
('public.read_external_source_dependencies(uuid,text[],uuid[],text[])','49d22c1cfdb98f6eb0d4421a8c080bebc55b3d843f234d0805968366db4186a2',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'sql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_entity_derivation_source(uuid,text,uuid)','0ad65b7aac53f11ae3cf141d1ef2c364e02a845e4b3a12ba67d8f1b44819a484',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['app_user','owner']::text[]),
('public.read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])','8a01f2a9a01cbe613ce23a519610a77e3ae8354bef88df8e99cab0d32bcc2bcd',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])','decf5058016df0127f14f201c843b311dad798075d3a86ed41071523139c7018',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.application_recorded_field_state_before_record_ancestry(uuid,uuid,text,integer)','5229402d0ab6ce285d05f74ba1383922e73fd21cc8ca8debe264b4276b4d14d4',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.application_native_field_contract_for(uuid,jsonb,text,text)','3cb218f343642f0a488d9d068b2f7d0ce60684a9b7562499b6e433c4a35d8348',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.application_native_same_destination(uuid,text,uuid,text,uuid)','55330701886e92894618761c62c5211d192982bf52690e878f412006ec586426',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'sql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.application_reader_envelope_visible(uuid,jsonb)','f90756d72a86d2339017ee415b5ca0431bc7c96cbda5d5f621d56117303c6c13',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_scope_source(uuid,text,uuid)','1dcd42d80b74fa720d77b1493eb523d8231d46afd6fb64a1e1d1a756a937fef1',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.scope_source_table(text)','adc507baa12e1e269887ce7734b66abfce202cb44baf64aea866f2ff82343984',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'sql',false,'i',false,'u',ARRAY['owner']::text[]),
('public.application_compute_field_envelope_before_session_eval(uuid,jsonb,text,uuid,text,text,text[],integer)','96caaec1306351ae65ce2f5e20e518bf4ad17638518ee5e573eb5796225d6368',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.application_field_projection_state_before_memory_history(uuid,jsonb,text,uuid,text,text,text[])','cce6c6fb71adc777de6b9ad283e653afe2167a0aec4dd8186f473dda0aa26d7a',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.application_memory_field_state_before_successor(uuid,uuid,text[])','5971d9e0ea9d2fe043dc684ae44d6123815c487cafe4dba4a80a7cdb1e827a7b',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb)','1f5afc1d54fb3bbb09a9719cbc0b4d6b2bcd6cb5743df2143abc5abb7700a864',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.application_memory_query_context(uuid)','01005c743471b53304ef3b6c2b5154f67961231496c4be53e24b85cbce3f93bd',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_admitted_native_scope_snapshot_before_knowledge_versions(uuid,text,uuid)','bc3db1aed4d28b1b2370f93814113a706114017651b20986715bde843a07a24d',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['app_user','owner']::text[]),
('public.application_scope_source_edges(uuid,text,uuid,text)','14535b6ea617c43c10f030e519d61bfc558f649876530f9d9f03cc019f7d6be3',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'sql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.agent_read_scope_allows(text,text[],uuid[])','9df132d3e3bd6c9b75dae6973a59f2467ec01abf7abb937dbbd2a98bd7708b21',NULL::text[],'plpgsql',false,'s',false,'u',ARRAY['owner','public']::text[]),
('public.agent_scope_grant_allows(text,text[])','c7a3e918c06959a655a363469e17d12b28bc009e4096b532c307d84f6b190006',NULL::text[],'plpgsql',false,'s',false,'u',ARRAY['owner','public']::text[]),
('public.agent_visibility_allows(uuid,uuid,uuid)','78be49e90b2791a9f15b4e91029bd92345806b0493c2f802b9edfbdf412874e4',NULL::text[],'plpgsql',false,'s',false,'u',ARRAY['owner','public']::text[]),
('public.department_read_grants()','5e30abe1b1329118f1fcc853ede5b24ee3ac2e228f60cc78cac936b8fdbb59f4',ARRAY['search_path=public, pg_temp']::text[],'sql',true,'s',false,'u',ARRAY['owner','public']::text[]),
('public.department_row_allows(jsonb,uuid,text,text[],uuid)','6edabea953c5e49f021aed4b05daf646ecc3770b6da1c24b91306da394252497',NULL::text[],'sql',false,'i',false,'s',ARRAY['owner','public']::text[]),
('public.member_operation_scope_allows(uuid,text,text[],boolean)','16aa61024e315456f940c9580259698b8daf789959b85c644b4930ff041831db',ARRAY['search_path=public, pg_temp']::text[],'sql',true,'s',false,'u',ARRAY['owner','public']::text[]),
('public.application_memory_field_keys()','602979c8ba739025a24515a6df7928c83652c5da6dd16084700c060c9d7b7574',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'sql',false,'i',false,'u',ARRAY['owner']::text[]),
('public.read_entity_derivation_source_before_memory_successor(uuid,text,uuid)','7a6319985c3df2597f7c97701de1ac66f5f2737b73439363b55a81866d4bc07a',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['app_user','owner']::text[]),
('public.application_native_field_catalog_for(uuid,jsonb,text)','60107ab73617b2939b29bacfb345c85d4f94176b17a4d63d6caf4a6fc1b1f336',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.application_native_field_contract_before_catalog(uuid,jsonb,text,text)','f723e8682851323db492fb0278063f82a1225bb53e201a64adebb755a0bb3022',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.application_native_record_port_valid(regprocedure)','6f67edad6c9bfd5bc1fa93380974eef517644099c4680cb5bc597610cf0aaf51',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'sql',true,'s',false,'u',ARRAY['owner']::text[]),
('public.read_scope_source_before_persistent_context(uuid,text,uuid)','98938b6884001253442193cb62258afd99fad56ce83409e9466c33dfb923b0e3',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.scope_source_table_before_knowledge_versions(text)','50b1e162e95c2cb9e01300d2ed70041cf89350004e11476352463eeba1e9d3d6',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'sql',false,'i',false,'u',ARRAY['owner']::text[]),
('public.application_compute_field_envelope_before_query_points(uuid,jsonb,text,uuid,text,text,text[],integer)','5111aa6e6bf60cb0f7f64b5161bf230f3463e7160c2b1584d1e9f59c0e70bde0',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.application_field_projection_state_before_memory_query(uuid,jsonb,text,uuid,text,text,text[])','670fc5874fbdc599f1f61839d27804b08edbdc569a796e9a6933a5a20f260f9a',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)','a1ab7ec9c6235a764ee8ea34a7beda114daf9813b7d95330410c71cf677ee991',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.application_memory_query_candidate_state(uuid,uuid,text[],jsonb)','bbf026369de235fe6b808e68c053f32386ce8f49a7b2a355c265cf8d533d2cac',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.application_native_query_bounds(uuid)','4b53d101c72abb90d3111a31a225caddb80795c303390678ad53b48f36abbf22',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.application_normalize_native_query_bounds(jsonb)','a93c447ccf5bb7c51658e96b91acf8ca17f2815bc0e8ef535ee92d9f4e98fc80',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',false,'i',false,'u',ARRAY['owner']::text[]),
('public.read_admitted_native_scope_snapshot_before_persistent_context(uuid,text,uuid)','6ae4d0a5a9420a4f20f76aa9d8c7e6c066add8635517affcdda2f386d2260ac0',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['app_user','owner']::text[]),
('public.knowledge_version_source_edges(uuid,text,uuid,text)','f4deb0d7b7ef41db5dc1d2fedabcef545c836b9f8a78f48d55a2c7413e62f1cf',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.sensitivity_rank(text)','ac5ff3f6a5ec1a64a13b16c9f408e552e13462054a939a0cc2710b62e2c65a8f',NULL::text[],'sql',false,'i',true,'u',ARRAY['owner','public']::text[]),
('public.department_read_grants_for(uuid)','b75402900c3899c0cd638989c905c736207a68b4f96eb89ec15d7503070b191a',ARRAY['search_path=public, pg_temp']::text[],'sql',true,'s',false,'u',ARRAY['owner']::text[]),
('public.member_operation_grants(boolean,uuid)','c5fb0763fd83aff7ad1c9fa1e7f5228bcb038b1fc4b95a143eb495b62b7c51ba',ARRAY['search_path=public, pg_temp']::text[],'sql',true,'s',false,'u',ARRAY['owner','public']::text[]),
('public.member_operation_row_allows(jsonb,uuid,text,text[])','424ae78abb8f31f1f2f5595933b2deda208dc7460315ee28712ab2ae31292394',NULL::text[],'sql',false,'i',false,'s',ARRAY['owner','public']::text[]),
('public.application_query_scope_cap(integer,jsonb,jsonb)','c55c9d4c986dea17eb03b2217a9ba31722bc14044e127fd03c512ff641fa5b67',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',false,'i',false,'u',ARRAY['owner']::text[]),
('public.read_entity_derivation_source_before_knowledge_versions(uuid,text,uuid)','9e7b910d3b342a84e4bc9176c3b361ead9b4e33c0e17cd997cc2f3798f282747',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['app_user','owner']::text[]),
('public.assistant_placement_visible(uuid,uuid)','e11d527687e67a43dddcb65769c05f11ff26253baab2817f41aace2c9ea41300',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'sql',true,'s',false,'u',ARRAY['owner','public']::text[]),
('public.member_principal_operation_grants(uuid,boolean,uuid)','cfe75967c93640be7dbe26514b862a10b9a2364d51bf1eeb76f805cf76523806',ARRAY['search_path=public, pg_temp']::text[],'sql',true,'s',false,'u',ARRAY['owner']::text[]),
('public.application_native_catalog_port_valid(regprocedure)','62c0f2dd329397679a170e82fc8371e5acc76636b640864056d76ad8bce67d14',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'sql',true,'s',false,'u',ARRAY['owner']::text[]),
('public.read_scope_source_before_application_fields(uuid,text,uuid)','668325bf1536c633ddaf44c0c551c4c5aebd06c503a36c8ea11b645db2fcc7a8',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.scope_source_table_before_persistent_context(text)','77ae7215cf985148bc013cd5afd14cac03776580e347bf548c67b6d1ca7f40da',NULL::text[],'sql',false,'i',false,'u',ARRAY['owner']::text[]),
('public.application_compute_field_envelope_before_module_policy(uuid,jsonb,text,uuid,text,text,text[],integer)','663ccc34b9ccac90634056f4268555f9b746b368c04813df21cd6011901dac3c',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.application_principal_query_bounds(uuid,uuid,boolean)','7387acc411884780cdaeea9fb30787bbae2205252582dd1fe636f9d2a4403cdd',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_admitted_native_scope_snapshot_before_public_share(uuid,text,uuid)','a53d51bdf98388324428e2f31f7cefbcb0464cefa42b6827060aa523bdca07ab',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['app_user','owner']::text[]),
('public.application_scope_source_edges_before_knowledge_versions(uuid,text,uuid,text)','20d8c359a6b77c9c96aed3be9e31719e60868fb55e34aaedc2714494e6a8e974',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'sql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.department_principal_grant_snapshot(uuid)','54de4ac8c77d359525a132f9e6d1dd6bfb11a798338018483a1a63f023ea6f80',ARRAY['search_path=public, pg_temp']::text[],'sql',true,'s',false,'u',ARRAY['owner']::text[]),
('public.read_entity_derivation_source_before_knowledge_source_parent(uuid,text,uuid)','d77c03dff1ca14de5989a2b9ac7245c8fe53cad9157bd07d4a3903c48dc4f090',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['app_user','owner']::text[]),
('public.read_resource_page_dependencies(uuid,text,uuid,text)','d274ecd7383a04fce33a8b8a579f9db21e9538dd8e33fb455b010fce86b49646',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.effective_member_read_compartments(uuid,uuid)','94209e28d759fe3c9ba98adb1d9df45276387d1661431cf18adc123d8ba5cd8a',ARRAY['search_path=public, pg_temp']::text[],'plpgsql',true,'s',false,'u',ARRAY['owner','public']::text[]),
('public.effective_member_team_compartments(uuid,uuid)','1272ae616f94127e2d87102fa0e3244cf481b98b7cd1dd6380aa08f7bd522237',ARRAY['search_path=public, pg_temp']::text[],'plpgsql',true,'s',false,'u',ARRAY['owner','public']::text[]),
('public.read_scope_source_before_external(uuid,text,uuid)','4dba5526338521c4aaf4199c01be4ab525548fc034f06e8ee962f6098f51ff55',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.scope_source_table_before_media(text)','93ff1be795bfbee59a38c43da3425018072c18007fe39e99ecd4d7e8731eba15',NULL::text[],'sql',false,'i',false,'u',ARRAY['owner']::text[]),
('public.application_query_scope_intersection(jsonb,jsonb)','f3a4e56a8b629afbae3bc0f8110749d83042bdda96dd5d5a5036f7299bcb0529',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',false,'i',false,'u',ARRAY['owner']::text[]),
('public.application_query_set_intersection(jsonb,jsonb)','4f00e708b35260b56dbd3af6fdfcbf8dfb9237b036c4c8d48b4f4a8cdbfbe693',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'sql',false,'i',false,'u',ARRAY['owner']::text[]),
('public.legacy_assistant_team_compartments(uuid)','389c66a0007207bd22a182172410da46628b63ddc9736af90e0cd29976c1250d',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'s',false,'u',ARRAY['owner']::text[]),
('public.project_member_live(uuid,text,uuid)','28b1701e32323c554c7cb43cc9323e9c9b48e273441aa2906f43afabe427695e',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'sql',true,'s',false,'u',ARRAY['owner','public']::text[]),
('public.read_admitted_native_scope_snapshot_before_application_sources(uuid,text,uuid)','1da6fae5f8e50f4f9d1e5a3af483c10e6671e36bdd0286873b0efa14cacb1791',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.scope_source_ancestors(uuid,text,uuid)','d8e33fb3a66e4318ed159e288c797b6d55759481e1339d4e53c372cb6907e0e8',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_entity_derivation_source_before_persistent_context(uuid,text,uuid)','e0ca32ac14a733040338a7cf1b33a7219cb289555491c3b9574e5e5fc10276d9',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['app_user','owner']::text[]),
('public.read_scope_source_before_routines(uuid,text,uuid)','b6f4894794b69b1a00715d1e6f20dcd11fdf984ad680f4dfe3ff1b0ebf1081d3',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.scope_source_ancestors_before_workflow_run(uuid,text,uuid)','36bdb461a66fb00b81a5f0f6672b48dcc150858328b035b1ba1da0c3ed3715c8',ARRAY['search_path=public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_entity_derivation_source_before_application_fields(uuid,text,uuid)','5d676d04f8b25511b5d03def6cdc153d7cef32778726bb1953ed25b2d64ce499',ARRAY['search_path=public, pg_temp']::text[],'sql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_scope_source_before_page(uuid,text,uuid)','49b18adb64353eee77d2b54f14c10c0b25558fd500103c1cb1ee41a03473ab80',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.scope_source_ancestors_before_browser_session(uuid,text,uuid)','c5a684292738319265321ce21b76ea01ba775eb216af66ae992c190d39eedc5c',ARRAY['search_path=public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_entity_derivation_source_before_engineering_archive(uuid,text,uuid)','8cecfe01edcc675b99b24fce8470332ae1268086eedd627cb12791905f534440',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['app_user','owner']::text[]),
('public.read_scope_source_before_workflow_run(uuid,text,uuid)','165433106a00f6f13935e703c48de3bfa602549fbbb4f7b18a4ad4fc5b7f64d8',ARRAY['search_path=public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.scope_source_ancestors_before_browser_profile(uuid,text,uuid)','401b62c0bf792041938e92d7ea4207f4a3f7bb9f070bfb6a4bea3aa0ee5cb957',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_entity_derivation_source_before_page(uuid,text,uuid)','7fa59b5ad9959eeea213555827788178876559d50f9b8901177323ee7c01479f',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_scope_source_before_browser_session(uuid,text,uuid)','26e5d49fedaa442e4b40ff972e0004c243a745e232d7db9d580626f666b644da',ARRAY['search_path=public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_entity_derivation_source_before_conversation(uuid,text,uuid)','84470b7e75dab7a200af9b8a36c67e30049c4d63b6167bb9ae1fb5d1a02cf684',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_scope_source_before_browser_profile(uuid,text,uuid)','f2f759fcd752c85b6b699292a7d3e0d131eb104e08ff92534fcc31ece601b793',ARRAY['search_path=public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_entity_derivation_source_before_primitive_v2(uuid,text,uuid)','cf37a2b56386164b97a10dc6481746db525f142d4fb8bdc2c7b669e59e9b9757',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_scope_source_before_knowledge_binding(uuid,text,uuid)','efa7dd7b9936ff365102640731d45a9b908674a25f5291b71706a333d992e7bc',ARRAY['search_path=public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_entity_derivation_source_before_blueprint(uuid,text,uuid)','6d5e4db46f88db7fc95887bf9c27dc8b559a1454c915259c7fbd00c71e079efe',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_entity_derivation_source_before_workflow_run(uuid,text,uuid)','729355a67ae979e9648492b81e6ba6ed818cb958be736ce980db5ccc49307dec',ARRAY['search_path=public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_entity_derivation_source_before_browser_session(uuid,text,uuid)','82efb78e665175f49435b22bdd4e833dc6fee137538b48201ca4d3de87b406b0',ARRAY['search_path=public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_entity_derivation_source_before_browser_profile(uuid,text,uuid)','db659d6fd7c52b9cbbf2ae9e0700e85528a3b33a18496bc6ba04374330da11c6',ARRAY['search_path=public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_media_parent_snapshot(uuid,text,uuid)','e522daec94a9416245e635f50638f21c7d31ee031745d602b4f806368a7bc910',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_media_parent_snapshot_before_conversation(uuid,text,uuid)','5c92cb41bb2042f15a15199607bc701f412984940f54ab3aaa3e6ac788d3381e',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_media_parent_snapshot_before_page(uuid,text,uuid)','ef1f220183aa208e2e3d635083cfdaf3d4974f19c007af97d3191ef46313f4f5',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_media_parent_snapshot_before_primitive_v2(uuid,text,uuid)','869504acef68d93f869e868d2701980b37179283c606307c2cc5da9f5a260e9a',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_media_parent_snapshot_before_blueprint(uuid,text,uuid)','170177c10289d3cebf3b86aea773402b8f5ad0b046ef8682b8337f12048d6a8d',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_media_parent_snapshot_before_workflow_run(uuid,text,uuid)','805fd89a1ffdfa92546aaecbff5c5b40f50e17bc48a889ea6de88c08190ce894',ARRAY['search_path=public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_media_parent_snapshot_before_browser_session(uuid,text,uuid)','88a1bcb6d875e0888dc69e2effea30313903d64f52967e82a413ec85097d9588',ARRAY['search_path=public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_media_parent_snapshot_before_browser_profile(uuid,text,uuid)','91d34ebf8bb93d0f47983dda182bcc8bafe411abfed909da21fbe7cf79c2b583',ARRAY['search_path=public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_entity_derivation_source_before_recordings(uuid,text,uuid)','4125a24719ffa24669e0ee6895f3c3799a82d9612799a1da5f2a788f98ada99d',ARRAY['search_path=public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.read_entity_derivation_source_before_capture(uuid,text,uuid)','cdc03dd1c41f3a47d810a4f3acc0e53d2697e255a74b461b6fa4194b89419333',ARRAY['search_path=public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner','public']::text[]),
('public.application_native_member_field_permissions(uuid,jsonb,uuid)','a430f9d8bfe86459de513f345abdb97ad961b20179d4ba447cf77e7a00c997bc',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'s',false,'u',ARRAY['owner']::text[]),
('public.application_native_field_rule_allows(jsonb,text[])','b8df2bb10cb0d3448b7392e03dd7107a98b7ba61d1b6125eacc5a6ef2509b9e3',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'sql',false,'i',false,'u',ARRAY['owner']::text[]),
('public.application_session_eval_scope(uuid,text,uuid,text,jsonb)','96e58ebe7bcdfd022d16d1533cbfaf72076c9694141cd754c1cf18e6ec7ba13f',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',true,'v',false,'u',ARRAY['owner']::text[]),
('public.application_query_scope_valid(jsonb)','8831b4a7d96a0da154357bb077360950751e99b365361808c0c03ea7994d10d9',ARRAY['search_path=pg_catalog, public, pg_temp']::text[],'plpgsql',false,'i',false,'u',ARRAY['owner']::text[])) reviewed(signature,body_hash,config,language,security_definer,volatility,is_strict,parallel_setting,acl)
 -- Validate every fixed helper body/property/owner/ACL before using local metadata
 -- to reconstruct the exact reviewed lineage body. The lineage entry runs last.
 ORDER BY signature='public.application_scope_lineage(uuid,text[],uuid[],text[])' LOOP
  IF expected.signature='public.application_scope_lineage(uuid,text[],uuid[],text[])' THEN
   SELECT string_agg(format('(%s::oid,%L::text)',p.oid,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(jsonb_build_object('name',p.proname,'namespace',p.pronamespace,'body',p.prosrc,
     'config',p.proconfig,'language',p.prolang,'securityDefiner',p.prosecdef,'volatility',p.provolatile,'strict',p.proisstrict,'parallel',p.proparallel)::text,'UTF8')),'hex')),',' ORDER BY helper.ordinal),count(*)
    INTO lineage_pins,lineage_pin_count
    FROM unnest(ARRAY[
     'public.application_scope_source_edges(uuid,text,uuid,text)',
     'public.application_scope_source_edges_before_knowledge_versions(uuid,text,uuid,text)',
     'public.knowledge_version_source_edges(uuid,text,uuid,text)',
     'public.scope_source_ancestors(uuid,text,uuid)',
     'public.scope_source_ancestors_before_workflow_run(uuid,text,uuid)',
     'public.scope_source_ancestors_before_browser_session(uuid,text,uuid)',
     'public.scope_source_ancestors_before_browser_profile(uuid,text,uuid)',
     'public.scope_source_table(text)',
     'public.scope_source_table_before_knowledge_versions(text)',
     'public.scope_source_table_before_persistent_context(text)',
     'public.scope_source_table_before_media(text)']::text[]) WITH ORDINALITY helper(signature,ordinal)
    JOIN pg_catalog.pg_proc p ON p.oid=to_regprocedure(helper.signature);
   IF lineage_pin_count<>11 THEN RAISE EXCEPTION 'Memory statement lineage prerequisites missing';END IF;
   expected.body_hash:=encode(sha256(convert_to(format(reviewed_lineage_body,lineage_pins),'UTF8')),'hex');
  END IF;
  -- Predecessor migrations grant this named role only when it exists. Absence
  -- permits no replacement principal; an existing role still needs its exact ACL.
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
   expected.acl:=array_remove(expected.acl,'app_user');
  END IF;
  SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure(expected.signature);
  IF NOT FOUND THEN RAISE EXCEPTION 'Legacy function prerequisite missing: %',expected.signature;END IF;
  SELECT array_agg(CASE WHEN a.grantee=actual.proowner THEN 'owner' WHEN a.grantee=0 THEN 'public' ELSE pg_get_userbyid(a.grantee) END ORDER BY CASE WHEN a.grantee=actual.proowner THEN 'owner' WHEN a.grantee=0 THEN 'public' ELSE pg_get_userbyid(a.grantee) END) INTO actual_acl
   FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a WHERE a.privilege_type='EXECUTE' AND NOT a.is_grantable AND a.grantor=actual.proowner;
  -- Accept only the canonical ACL plus this one owner-issued legacy grant.
  -- No revocation occurs until every prerequisite has passed.
  IF NOT 'app_user'=ANY(expected.acl) AND 'app_user'=ANY(actual_acl) THEN
   repair_signatures:=array_append(repair_signatures,expected.signature);
   SELECT array_agg(principal ORDER BY principal) INTO expected.acl
    FROM unnest(array_append(expected.acl,'app_user')) principal;
  END IF;
  IF encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex') IS DISTINCT FROM expected.body_hash
   OR actual.proconfig IS DISTINCT FROM expected.config OR actual.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname=expected.language)
   OR actual.prosecdef IS DISTINCT FROM expected.security_definer OR actual.provolatile::text IS DISTINCT FROM expected.volatility
   OR actual.proisstrict IS DISTINCT FROM expected.is_strict OR actual.proparallel::text IS DISTINCT FROM expected.parallel_setting
   OR actual.proowner IS DISTINCT FROM (SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
   OR actual_acl IS DISTINCT FROM expected.acl OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a WHERE a.privilege_type<>'EXECUTE' OR a.is_grantable OR a.grantor<>actual.proowner) THEN
   RAISE EXCEPTION 'Legacy function prerequisite changed: %',expected.signature;
  END IF;
 END LOOP;
 -- These 22 preexisting private helpers are independently pinned by 8121-8133.
 -- Metadata and SHA256 bodies match the canonical pre-8111 replay; lifecycle
 -- bodies use the pre-8122 versions. Type names avoid installation-local OIDs.
 FOR extra IN SELECT value FROM jsonb_array_elements($reviewed_private$
[{"signature":"public.guard_application_legacy_review_metadata()","body_hash":"219d28303d2267809c7c49e47ecf28727b745a1fedca77c26ae176abbe7141b4","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"guard_application_legacy_review_metadata","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":false,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proargdefaults":null,"pronargdefaults":0},"result":"trigger","language":"plpgsql"}
,{"signature":"public.application_legacy_review_authorize(uuid,uuid)","body_hash":"4ee8d67ece6f57f87aa244481dccbaca3c01b5930735c632f1c4674548f5ad08","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_legacy_review_authorize","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","acting"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proargdefaults":null,"pronargdefaults":0},"result":"uuid","language":"plpgsql"}
,{"signature":"public.application_legacy_inventory_registry()","body_hash":"59293458203aac90a26064f57936a451a6476fa996293e15418d617ed4c1a4fa","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_legacy_inventory_registry","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":false,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"i","proleakproof":false,"proargdefaults":null,"pronargdefaults":0},"result":"text[]","language":"sql"}
,{"signature":"public.application_legacy_review_snapshot(uuid,text,uuid)","body_hash":"3d69c4a78cf33a5f248c9d9a155253fc82bdf655e6231024165e2a78e424033c","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_legacy_review_snapshot","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proargdefaults":null,"pronargdefaults":0},"result":"jsonb","language":"plpgsql"}
,{"signature":"public.application_legacy_review_impact(uuid,text,uuid)","body_hash":"c115fc3d70980c94faff285a32f46756d19712b99f6409dcb4e2c34f56e45e71","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_legacy_review_impact","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proargdefaults":null,"pronargdefaults":0},"result":"jsonb","language":"plpgsql"}
,{"signature":"public.application_legacy_repair_plan(uuid,uuid)","body_hash":"30cccdcdc1bb27fa86e8d73f4716d9004e9545fee3de95e167959d4d35fb78bb","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_legacy_repair_plan","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proargdefaults":null,"pronargdefaults":0},"result":"jsonb","language":"plpgsql"}
,{"signature":"public.application_force_native_task_written_field()","body_hash":"9de042a0ad8db22b36ccee11c59b24af36b3e40c4ac8f4f82b903d86bddbcc9f","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_force_native_task_written_field","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proargdefaults":null,"pronargdefaults":0},"result":"trigger","language":"plpgsql"}
,{"signature":"public.application_record_native_task_write_intent(tasks,text[],text)","body_hash":"68686ea1edfa1579a6a5b1192342da12fd08ca87c5391975ad4692f44b3b790b","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_record_native_task_write_intent","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["task_row","write_fields","write_action"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proargdefaults":null,"pronargdefaults":0},"result":"void","language":"plpgsql"}
,{"signature":"public.application_recheck_native_task_write_intent()","body_hash":"7e5016040ba60e44ab5872f595ec78d2fcc46a879d1c6de0477afa27b020c6a5","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_recheck_native_task_write_intent","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proargdefaults":null,"pronargdefaults":0},"result":"trigger","language":"plpgsql"}
,{"signature":"public.application_scoped_grant_allowed_before_records(uuid,jsonb)","body_hash":"4670f6121322f9db3159bfe5968e81c42191ac15d344ba427d77e9cf4a8ccd8b","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_scoped_grant_allowed_before_records","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public"],"proretset":false,"prosecdef":true,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["a","p"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proargdefaults":null,"pronargdefaults":0},"result":"boolean","language":"plpgsql"}
,{"signature":"public.application_guard_native_module_lifecycle()","body_hash":"5e476c25d2c98e309db80a109cd474b9c1f9f2e5ababa84f87f5fae091eb4b69","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_guard_native_module_lifecycle","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proargdefaults":null,"pronargdefaults":0},"result":"trigger","language":"plpgsql"}
,{"signature":"public.application_record_native_module_lifecycle()","body_hash":"26362cdcd3ea53ad451a3adb680b23934191894782b2eef140ae539cdb84013a","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_record_native_module_lifecycle","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proargdefaults":null,"pronargdefaults":0},"result":"trigger","language":"plpgsql"}
,{"signature":"public.application_memory_history_field_state(uuid,uuid,text,text[])","body_hash":"56ed4b131814a330929f60ed808cea3400ee9ac809e6bc30603a6ef7eacc8fbc","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_memory_history_field_state","prorows":0,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i","v","fields"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proargdefaults":null,"pronargdefaults":0},"result":"jsonb","language":"plpgsql"}
,{"signature":"public.application_memory_historical_contract_before_catalog(uuid,jsonb,text,text)","body_hash":"65a0cd5d26fc7b2e791244134d3dfb0312fee7b9ea973c77c2957c8f8b06cc28","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_memory_historical_contract_before_catalog","prorows":0,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","p_origin","p_type","p_id"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proargdefaults":null,"pronargdefaults":0},"result":"jsonb","language":"plpgsql"}
,{"signature":"public.application_field_envelope_ancestry_allowed(uuid,jsonb)","body_hash":"95eb89fff18ed7d445d729f0762864882c8245eff5efcede8a696d70ee883d07","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_field_envelope_ancestry_allowed","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","envelope"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proargdefaults":null,"pronargdefaults":0},"result":"boolean","language":"plpgsql"}
,{"signature":"public.validate_application_field_dependencies()","body_hash":"610b645eff660e96b9e9dac4d484d722cafb70a1c1766e39232217a832430774","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"validate_application_field_dependencies","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp","plan_cache_mode=force_generic_plan"],"proretset":false,"prosecdef":true,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proargdefaults":null,"pronargdefaults":0},"result":"trigger","language":"plpgsql"}
,{"signature":"public.application_scoped_grant_allowed_before_modules(uuid,jsonb)","body_hash":"d195199a168c7a6de27c534eef2930beb17d2ce34d67671aa87165ac729c0f70","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_scoped_grant_allowed_before_modules","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public"],"proretset":false,"prosecdef":true,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["a","p"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"proargdefaults":null,"pronargdefaults":0},"result":"boolean","language":"plpgsql"}
,{"signature":"public.application_path_fields(jsonb,jsonb,uuid,jsonb,text,text,uuid,text,text[],uuid[],uuid,text,jsonb)","body_hash":"0868a145b275e18e51419d92650e0238308a6fc4f740ed395a86bc3fbad6ffb1","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_path_fields","prorows":0,"pronargs":13,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["maximum","subject","w","origin","type_key","record_id","owner_id","tier","teams","projects","row_user","action","prospective_data"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proargdefaults":"({CONST :consttype 3802 :consttypmod -1 :constcollid 0 :constlen -1 :constbyval false :constisnull true :location -1 :constvalue <>})","pronargdefaults":1},"result":"jsonb","language":"plpgsql"}
,{"signature":"public.application_query_catalog_path(jsonb,jsonb,jsonb,uuid,jsonb,text,jsonb)","body_hash":"ab1f905f503a6c0ce11f3d5a1f63a5a9e4377b8a8ed598aa52960758d416da1c","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_query_catalog_path","prorows":0,"pronargs":7,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["context","maximum","subject","w","p_origin","p_type","policy"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proargdefaults":null,"pronargdefaults":0},"result":"jsonb","language":"plpgsql"}
,{"signature":"public.prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)","body_hash":"9fb9c28d3cc51e700a195eaff5d3bc7d66b1a73e4c6a6dbe785d69be9c15e551","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"prepare_native_session_message_batch","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","producer","sources","target"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proargdefaults":null,"pronargdefaults":0},"result":"jsonb","language":"plpgsql"}
,{"signature":"public.application_session_eval_point_state(uuid,text,uuid,text[],jsonb)","body_hash":"f5193aa3bf1e6824d9923260e9a1944c7f7e36169d52e3852fc2489479411fe0","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_session_eval_point_state","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","t","i","fields","memo"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proargdefaults":null,"pronargdefaults":0},"result":"jsonb","language":"plpgsql"}
,{"signature":"public.record_admitted_memory_successor_derivation(uuid,text,uuid,text,text,jsonb,uuid,text)","body_hash":"314605f62ea1c6ab91f89d34365df371ba5793f0dd89f52f0c9da5769bf1da4f","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"record_admitted_memory_successor_derivation","prorows":0,"pronargs":8,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i","v","producer","sources","predecessor","expected_version"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proargdefaults":null,"pronargdefaults":0},"result":"uuid","language":"plpgsql"}]
 $reviewed_private$::jsonb) LOOP
  SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure(extra->>'signature');
  IF NOT FOUND THEN RAISE EXCEPTION 'Legacy function prerequisite missing: %',extra->>'signature';END IF;
  SELECT array_agg(CASE WHEN a.grantee=actual.proowner THEN 'owner' WHEN a.grantee=0 THEN 'public' ELSE pg_get_userbyid(a.grantee)::text END
    ORDER BY CASE WHEN a.grantee=actual.proowner THEN 'owner' WHEN a.grantee=0 THEN 'public' ELSE pg_get_userbyid(a.grantee)::text END)
   INTO actual_acl FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a;
  IF encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex') IS DISTINCT FROM extra->>'body_hash'
   OR actual.proowner IS DISTINCT FROM owner_id
   OR actual.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname=extra->>'language')
   OR actual.prorettype IS DISTINCT FROM to_regtype(extra->>'result')::oid OR actual.proallargtypes IS NOT NULL
   OR to_jsonb(actual)-ARRAY['oid','pronamespace','proowner','prolang','prosrc','proacl','prorettype','proargtypes','proallargtypes']
    IS DISTINCT FROM extra->'metadata'
   OR (actual_acl IS DISTINCT FROM ARRAY['owner']::text[] AND actual_acl IS DISTINCT FROM ARRAY['app_user','owner']::text[])
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
    WHERE a.privilege_type<>'EXECUTE' OR a.is_grantable OR a.grantor<>owner_id) THEN
   RAISE EXCEPTION 'Legacy function prerequisite changed: %',extra->>'signature';END IF;
  IF 'app_user'=ANY(actual_acl) THEN repair_signatures:=array_append(repair_signatures,extra->>'signature');END IF;
 END LOOP;
 FOREACH repair_signature IN ARRAY repair_signatures LOOP
  EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM app_user',repair_signature::regprocedure);
 END LOOP;
 EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM app_user',pg_get_userbyid(owner_id));
END $legacy_function_privileges$;
COMMIT;
