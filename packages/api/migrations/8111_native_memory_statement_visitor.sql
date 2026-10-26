BEGIN;
-- [COMP:api/application-persistence] Private statement-local native Memory visitor.
DO $memory_statement_prerequisite$
DECLARE expected record;actual pg_proc;actual_acl text[];
 lineage_pins text;lineage_pin_count integer;
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
    public.application_field_digest(jsonb_build_object('name',p.proname,'namespace',p.pronamespace,'body',p.prosrc,
     'config',p.proconfig,'language',p.prolang,'securityDefiner',p.prosecdef,'volatility',p.provolatile,'strict',p.proisstrict,'parallel',p.proparallel))),',' ORDER BY helper.ordinal),count(*)
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
  IF NOT FOUND THEN RAISE EXCEPTION 'Memory statement prerequisite missing: %',expected.signature;END IF;
  SELECT array_agg(CASE WHEN a.grantee=actual.proowner THEN 'owner' WHEN a.grantee=0 THEN 'public' ELSE pg_get_userbyid(a.grantee) END ORDER BY CASE WHEN a.grantee=actual.proowner THEN 'owner' WHEN a.grantee=0 THEN 'public' ELSE pg_get_userbyid(a.grantee) END) INTO actual_acl
   FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a WHERE a.privilege_type='EXECUTE' AND NOT a.is_grantable AND a.grantor=actual.proowner;
  IF encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex') IS DISTINCT FROM expected.body_hash
   OR actual.proconfig IS DISTINCT FROM expected.config OR actual.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname=expected.language)
   OR actual.prosecdef IS DISTINCT FROM expected.security_definer OR actual.provolatile::text IS DISTINCT FROM expected.volatility
   OR actual.proisstrict IS DISTINCT FROM expected.is_strict OR actual.proparallel::text IS DISTINCT FROM expected.parallel_setting
   OR actual.proowner IS DISTINCT FROM (SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
   OR actual_acl IS DISTINCT FROM expected.acl OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a WHERE a.privilege_type<>'EXECUTE' OR a.is_grantable OR a.grantor<>actual.proowner) THEN
   RAISE EXCEPTION 'Memory statement prerequisite changed: %',expected.signature;
  END IF;
 END LOOP;
END $memory_statement_prerequisite$;

CREATE OR REPLACE FUNCTION public.application_memory_statement_state(w uuid, i uuid, fields text[], admitted jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE context jsonb;source jsonb;policy jsonb;mask jsonb;row_version text;values_json jsonb:='{}';field text;value jsonb;
BEGIN
 IF fields IS NULL OR NOT fields<@application_memory_field_keys() OR array_position(fields,NULL) IS NOT NULL
  OR cardinality(fields)<>(SELECT count(DISTINCT f) FROM unnest(fields) f) THEN RETURN NULL;END IF;
 context:=admitted->'context';
 IF context IS NULL OR NOT coalesce(to_jsonb(fields)<@(context->'read'),false) THEN RETURN NULL;END IF;
 SELECT scope_version::text INTO row_version FROM memories WHERE workspace_id=w AND id=i;
 IF NOT FOUND THEN RETURN NULL;END IF;
 -- Retained history without matching immutable current observations never becomes a native leaf.
 IF EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='memory' AND d.resource_id=i)
  AND NOT EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='memory' AND d.resource_id=i AND d.resource_version=row_version) THEN RETURN NULL;END IF;
 source:=admitted#>ARRAY['rows',i::text,'source'];
 IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR source->>'version' IS DISTINCT FROM row_version
  OR application_query_scope_admits_point(context->'bounds',source) IS NOT TRUE
  OR admitted#>ARRAY['rows',i::text,'lineage'] IS DISTINCT FROM jsonb_build_array(jsonb_build_object('kind','memory','id',i,'version',row_version)) THEN RETURN NULL;END IF;
 policy:=application_native_field_contract_for(w,'{"kind":"native","moduleKey":"native"}','memory',i::text);
 IF policy->>'registered' IS DISTINCT FROM 'false' THEN
  IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false'
   OR policy#>>'{metadata,recordVersion}' IS DISTINCT FROM row_version THEN RETURN NULL;END IF;
  mask:=read_native_application_field_mask(w,'{"kind":"native","moduleKey":"native"}','memory',i::text,row_version);
  IF mask IS NULL OR NOT coalesce(to_jsonb(fields)<@(mask->'readFields'),false) THEN RETURN NULL;END IF;
 END IF;
 -- Only the selected, already admitted fields are evaluated. No whole-row JSON before the mask.
 IF cardinality(fields)>0 THEN
  -- Identifiers come only from the validated selected field keys above.
  -- Each column is serialized individually after admission, never as a row.
  SELECT 'SELECT jsonb_build_object('||string_agg(format('%L,to_jsonb(%I)',selected,selected),',' ORDER BY ordinal)||
   ') FROM public.memories WHERE workspace_id=$1 AND id=$2 AND scope_version::text=$3'
   INTO field FROM unnest(fields) WITH ORDINALITY selection(selected,ordinal);
  EXECUTE field INTO values_json USING w,i,row_version;
 END IF;
 source:=jsonb_build_object('workspaceId',w,'userId',source->'userId','assistantId',source->'assistantId',
  'sensitivity',source->'sensitivity','compartments',source->'compartments','projectIds',source->'projectIds',
  'resourceKind','memory','resourceId',i,'version',row_version);
 RETURN jsonb_build_object('values',values_json,'source',source,'recordVersion',row_version,'sourceKind','memory','sourceId',i,'sourceVersion',row_version,'ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('kind','memory-fields-v1','fields',fields)),
  'legacyPolicyVersion',application_field_digest(jsonb_build_object('kind','memory-fields-v1','catalog',context#>'{policy,fingerprint}','record',policy->'fingerprint','mask',mask)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','memory-read-v2','catalog',context#>'{policy,fingerprint}','record',policy->'fingerprint','selectedRead',jsonb_build_object('fields',fields,'allowed',true))),
  'references','[]'::jsonb);
END $function$
;

CREATE OR REPLACE FUNCTION public.application_memory_statement_scan(w uuid, fields text[], bounds jsonb, include_retained boolean, frozen jsonb, admitted jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE candidate record;state jsonb;query_context jsonb;shared_context boolean:=false;count_value integer:=0;candidates jsonb:='[]';policies jsonb:='[]';excluded uuid[];
BEGIN
 IF fields IS NULL OR NOT fields<@application_memory_field_keys() OR application_query_scope_valid(bounds) IS NOT TRUE OR include_retained IS NULL THEN RETURN NULL;END IF;
 WITH RECURSIVE successors(id,depth) AS (
  SELECT t.successor_id,1 FROM native_memory_successor_transitions t JOIN jsonb_array_elements(frozen->'candidates') c ON t.predecessor_id=(c->>'id')::uuid
   WHERE t.workspace_id=w AND t.predecessor_version=c->>'version'
  UNION ALL SELECT t.successor_id,s.depth+1 FROM successors s JOIN native_memory_successor_transitions t ON t.workspace_id=w AND t.predecessor_id=s.id WHERE s.depth<100
 ) SELECT coalesce(array_agg(DISTINCT id),'{}') INTO excluded FROM successors;
 FOR candidate IN SELECT id,scope_version FROM memories WHERE workspace_id=w AND NOT id=ANY(excluded)
  AND (valid_to IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(frozen->'candidates') c WHERE c->>'id'=memories.id::text AND c->>'version'=memories.scope_version::text)) ORDER BY id LOOP
  count_value:=count_value+1;IF count_value>4096 THEN RETURN NULL;END IF;
  IF NOT include_retained AND EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='memory' AND d.resource_id=candidate.id) THEN CONTINUE;END IF;
  state:=application_memory_statement_state(w,candidate.id,fields,admitted);
  IF state IS NULL OR application_query_scope_admits_point(bounds,state->'source') IS NOT TRUE THEN CONTINUE;END IF;
  candidates:=candidates||jsonb_build_array(jsonb_build_object('id',candidate.id,'version',candidate.scope_version::text,'source',state->'source'));
  policies:=policies||jsonb_build_array(jsonb_build_object('id',candidate.id,'policy',
   CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(frozen->'policies') original_policy
    WHERE original_policy->>'id'=candidate.id::text AND original_policy->'policy'=state->'legacyPolicyVersion')
   THEN state->'legacyPolicyVersion' ELSE state->'policyVersion' END));
 END LOOP;
 RETURN jsonb_build_object('candidates',candidates,'policies',policies);
END $function$
;

CREATE OR REPLACE FUNCTION public.application_memory_statement_domain(w uuid, i uuid, fields text[], admitted jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE frozen application_query_domains;context jsonb;scanned jsonb;
BEGIN
 SELECT * INTO frozen FROM application_query_domains WHERE workspace_id=w AND id=i AND origin='{"kind":"native","moduleKey":"native"}' AND type_key='memory';
 IF NOT FOUND OR frozen.domain->>'kind' IS DISTINCT FROM 'memory_query_domain_v1'
  OR frozen.domain-ARRAY['kind','fields','bounds','visibility','includeRetained','candidates','policies']<>'{}'
  OR frozen.domain->'fields' IS DISTINCT FROM to_jsonb(fields) THEN RETURN NULL;END IF;
 context:=admitted->'context';
 IF context IS NULL OR context#>>'{policy,metadata,schemaVersion}' IS DISTINCT FROM frozen.schema_version
  OR NOT coalesce(to_jsonb(fields)<@(context->'read'),false)
  OR application_query_scope_union_contains(frozen.domain->'bounds',jsonb_build_array(context->'bounds'),4096)->>'contains' IS DISTINCT FROM 'true'
  OR frozen.domain->'visibility' IS DISTINCT FROM context->'visibility' THEN RETURN NULL;END IF;
 scanned:=application_memory_statement_scan(w,fields,frozen.domain->'bounds',(frozen.domain->>'includeRetained')::boolean,frozen.domain,admitted);
 IF scanned IS NULL OR scanned->'candidates' IS DISTINCT FROM frozen.domain->'candidates' OR scanned->'policies' IS DISTINCT FROM frozen.domain->'policies' THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('values','{}'::jsonb,'source',context#>'{policy,metadata,scope}','recordVersion',frozen.schema_version,
  'sourceKind','application_query_domain','sourceId',i,'sourceVersion',frozen.identity,'ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('kind','memory_query_domain_v1','identity',frozen.identity,'fields',fields)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','memory_query_domain_v1','identity',frozen.identity,'policy',context#>'{policy,fingerprint}','policies',scanned->'policies')),
  'references','[]'::jsonb);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $function$
;

CREATE OR REPLACE FUNCTION public.application_memory_statement_envelope(w uuid, p_origin jsonb, p_type text, p_id uuid, p_selection text, p_selected_version text, p_fields text[], depth integer DEFAULT 0, admitted_state jsonb DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE state jsonb; field_keys text[]; identity text; resource uuid; scope jsonb; version text;
 reference jsonb; child jsonb; children jsonb:='[]'; sources jsonb:='[]'; native_source jsonb; external record;
BEGIN
 IF depth NOT BETWEEN 0 AND 2 OR p_origin IS DISTINCT FROM '{"kind":"native","moduleKey":"native"}'::jsonb OR p_type IS DISTINCT FROM 'memory' OR p_selection NOT IN('read','query','identity','query_domain') OR p_selected_version IS NOT NULL OR admitted_state->'references' IS DISTINCT FROM '[]'::jsonb OR admitted_state ? 'queryPoints' THEN RETURN NULL; END IF;
 IF p_origin->>'kind'='generic' THEN p_type:='record.'||(p_origin->>'entityTypeId')::uuid; END IF;
 field_keys:=ARRAY(SELECT DISTINCT field FROM unnest(p_fields) field ORDER BY field);
 IF p_fields IS NULL OR cardinality(field_keys) IS DISTINCT FROM cardinality(p_fields) THEN RETURN NULL; END IF;
 state:=admitted_state;
 IF state IS NULL THEN RETURN NULL; END IF;
 scope:=jsonb_build_object('workspaceId',w,'userId',state#>'{source,userId}','assistantId',state#>'{source,assistantId}',
  'sensitivity',state#>'{source,sensitivity}','compartments',state#>'{source,compartments}','projectIds',state#>'{source,projectIds}');
 IF entity_derivation_envelope_valid(scope) IS NOT TRUE THEN RETURN NULL; END IF;
 identity:=application_field_digest(jsonb_build_object('workspaceId',w,'origin',p_origin,'typeKey',p_type,'id',p_id,
  'selection',p_selection,'selectedVersion',p_selected_version,'fields',field_keys,'fieldIdentity',state->'fieldIdentity'));
 resource:=application_field_resource_uuid(identity);
 FOR reference IN SELECT value FROM jsonb_array_elements(state->'references') ORDER BY value::text LOOP
  child:=application_compute_field_envelope(w,reference->'origin',reference->>'typeKey',(reference->>'id')::uuid,
   'identity',NULL,ARRAY(SELECT jsonb_array_elements_text(reference->'fields')),depth+1);
  IF child IS NULL THEN RETURN NULL; END IF;
  children:=children||jsonb_build_array(child);
  sources:=sources||jsonb_build_array(child->'source')||coalesce(child->'sources','[]'::jsonb);
  IF jsonb_array_length(sources)>=4096 THEN RETURN NULL; END IF;
 END LOOP;
 -- Preserve immutable external obligations independently of later native cleanup.
 -- This discovery is metadata only. Capture and every payload boundary must pin
 -- actual current source receipts; metadata discovery is never authorization.
 FOR external IN SELECT * FROM read_external_source_dependencies(w,ARRAY[state->>'sourceKind'],ARRAY[(state->>'sourceId')::uuid],ARRAY[state->>'sourceVersion']) LOOP
  IF external.source IS NULL OR external.source->>'workspaceId' IS DISTINCT FROM w::text
   OR external.node_version IS DISTINCT FROM external.source->>'version' THEN RETURN NULL; END IF;
  sources:=sources||jsonb_build_array(external.source);
  IF jsonb_array_length(sources)>=4096 THEN RETURN NULL; END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO sources
  FROM (SELECT DISTINCT value FROM jsonb_array_elements(sources)) unique_sources;
 version:=application_field_digest(jsonb_build_object('resourceId',resource,'recordVersion',state->'recordVersion',
  'sourceVersion',state->'sourceVersion','policyVersion',state->'policyVersion','scope',scope,'sources',sources));
 RETURN jsonb_build_object('resourceId',resource,'identity',identity,'origin',p_origin,'typeKey',p_type,'id',p_id,
  'selection',p_selection,'selectedVersion',p_selected_version,'fields',field_keys,'fieldIdentity',state->'fieldIdentity',
  'state',state,'children',children,'sources',sources,
  'source',scope||jsonb_build_object('resourceKind','application_field','resourceId',resource,'version',version));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $function$
;

CREATE OR REPLACE FUNCTION public.application_session_eval_field(w uuid, i uuid, v text, memo jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE key text:='field:'||i||':'||v;resource application_field_resources;observation application_field_observations;result jsonb;envelope jsonb;current_source jsonb;dependency record;refs jsonb:='[]';
BEGIN
 IF memo ? key THEN
  IF memo#>>ARRAY[key,'busy']='true' OR scope_review_state_held('application_field',i)
   OR application_session_eval_sources_current(w,memo#>ARRAY[key,'external']) IS NOT TRUE THEN RETURN jsonb_build_object('memo',memo);END IF;
  RETURN jsonb_build_object('memo',memo,'value',memo#>ARRAY[key,'value']);
 END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(memo-'memoryStatement'))>=4096 OR scope_review_state_held('application_field',i) THEN RETURN jsonb_build_object('memo',memo);END IF;
 SELECT * INTO resource FROM application_field_resources WHERE workspace_id=w AND id=i;
 IF NOT FOUND THEN RETURN jsonb_build_object('memo',memo);END IF;
 IF resource.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR (resource.type_key NOT IN('session_message','session_message_annotation') AND NOT(resource.type_key='memory' AND coalesce(memo#>>'{memoryStatement,workspaceId}'=w::text,false))) THEN
  current_source:=application_recorded_field_state_before_session_eval(w,i,v,0);
  RETURN jsonb_build_object('value',current_source,'memo',memo);
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles role JOIN pg_class tab ON tab.oid='session_messages'::regclass WHERE role.rolname=session_user
  AND (role.rolsuper OR role.rolbypassrls OR pg_has_role(role.oid,tab.relowner,'USAGE'))) THEN RETURN jsonb_build_object('memo',memo);END IF;
 SELECT * INTO observation FROM application_field_observations WHERE workspace_id=w AND resource_id=i AND version=v;
 IF NOT FOUND OR resource.selected_version IS NOT NULL THEN RETURN jsonb_build_object('memo',memo);END IF;
 memo:=memo||jsonb_build_object(key,jsonb_build_object('busy',true));
 result:=application_session_eval_envelope(w,resource.type_key,resource.resource_id,resource.selection,resource.fields,memo);
 memo:=coalesce(result->'memo',memo);envelope:=result->'value';
 IF envelope IS NULL OR envelope->>'identity' IS DISTINCT FROM resource.identity OR (envelope#>>'{state,policyVersion}' IS DISTINCT FROM observation.policy_version
   AND NOT coalesce(resource.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND resource.type_key='memory'
    AND envelope#>>'{state,legacyPolicyVersion}'=observation.policy_version,false))
  OR workflow_evidence_envelope_visible(w,observation.source_scope) IS NOT TRUE OR workflow_evidence_envelope_visible(w,envelope->'source') IS NOT TRUE THEN RETURN jsonb_build_object('memo',memo);END IF;
 FOR dependency IN SELECT * FROM application_field_observation_sources WHERE workspace_id=w AND resource_id=i AND version=v ORDER BY source_kind,source_id,source_version LOOP
  IF dependency.source_kind='application_field' THEN
   result:=application_session_eval_field(w,dependency.source_id,dependency.source_version,memo);memo:=coalesce(result->'memo',memo);current_source:=result->'value';
  ELSE current_source:=external_source_snapshot(w,dependency.source_id);END IF;
  IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false'
   OR dependency.source_kind='external_source' AND current_source->>'version' IS DISTINCT FROM dependency.source_version THEN RETURN jsonb_build_object('memo',memo);END IF;
 END LOOP;
 current_source:=(envelope->'source')||jsonb_build_object('held',false,'validTo',NULL,'retractedAt',NULL);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',source->'resourceId','version',source->'version') ORDER BY source::text),'[]') INTO refs
  FROM jsonb_array_elements(envelope->'sources') source WHERE source->>'resourceKind'='external_source';
 IF EXISTS(SELECT 1 FROM application_scope_lineage(w,ARRAY['application_field'],ARRAY[i],ARRAY[v]) n JOIN application_field_resources f
  ON f.workspace_id=w AND f.id=n.id WHERE n.kind='application_field'
   AND (f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR (f.type_key NOT IN('session_message','session_message_annotation') AND NOT(f.type_key='memory' AND coalesce(memo#>>'{memoryStatement,workspaceId}'=w::text,false))))) THEN
  memo:=memo-key;
 ELSE memo:=memo||jsonb_build_object(key,jsonb_build_object('value',current_source,'external',refs)); END IF;RETURN jsonb_build_object('memo',memo,'value',current_source);
END $function$
;

CREATE OR REPLACE FUNCTION public.application_session_eval_scope(w uuid, k text, i uuid, v text, memo jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE key text:='native:'||k||':'||i||':'||v;nodes jsonb;node jsonb;refs jsonb:='[]';current_source jsonb;result jsonb;dependency record;policy jsonb;mask jsonb;type_key text;
BEGIN
 IF memo ? key THEN
  IF memo#>>ARRAY[key,'busy']='true' THEN RETURN jsonb_build_object('value',false,'memo',memo);END IF;
  RETURN jsonb_build_object('value',memo#>ARRAY[key,'value']='true'::jsonb AND application_session_eval_sources_current(w,memo#>ARRAY[key,'external']),'memo',memo);
 END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(memo-'memoryStatement'))>=4096 THEN RETURN jsonb_build_object('value',false,'memo',memo);END IF;
 memo:=memo||jsonb_build_object(key,jsonb_build_object('busy',true));
 SELECT coalesce(jsonb_agg(to_jsonb(n)),'[]') INTO nodes FROM application_scope_lineage(w,ARRAY[k],ARRAY[i],ARRAY[v]) n;
 FOR node IN SELECT value FROM jsonb_array_elements(nodes) ORDER BY value->>'kind',value->>'id',value->>'version' LOOP
  IF node->>'kind'='application_field' THEN
   result:=application_session_eval_field(w,(node->>'id')::uuid,node->>'version',memo);memo:=result->'memo';current_source:=result->'value';
   refs:=refs||coalesce(memo#>ARRAY['field:'||(node->>'id')||':'||(node->>'version'),'external'],'[]'::jsonb);
   IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false' THEN RETURN jsonb_build_object('value',false,'memo',memo);END IF;
  ELSIF node->>'kind'='external_source' THEN
   refs:=refs||jsonb_build_array(jsonb_build_object('id',node->'id','version',node->'version'));
   current_source:=external_source_snapshot(w,(node->>'id')::uuid);
   IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false' OR current_source->>'version' IS DISTINCT FROM node->>'version' THEN
    RETURN jsonb_build_object('value',false,'memo',memo);END IF;
  ELSIF scope_source_table(node->>'kind') IS NOT NULL THEN
   IF node->>'kind'='session_context_revision' AND read_entity_derivation_source(w,node->>'kind',(node->>'id')::uuid) IS NULL THEN
    RETURN jsonb_build_object('value',false,'memo',memo);END IF;
   current_source:=read_admitted_native_scope_snapshot(w,node->>'kind',(node->>'id')::uuid);
   IF node->>'kind' IN('crm_event','session_context_revision') AND current_source IS NULL
    OR current_source IS NOT NULL AND current_source->>'held' IS DISTINCT FROM 'false' THEN RETURN jsonb_build_object('value',false,'memo',memo);END IF;
  END IF;
 END LOOP;
 FOR dependency IN SELECT DISTINCT d.* FROM scope_derivations d JOIN jsonb_array_elements(nodes) ancestor(value)
  ON d.resource_kind=ancestor.value->>'kind' AND d.resource_id=(ancestor.value->>'id')::uuid WHERE d.workspace_id=w LOOP
  IF nullif(current_setting('app.application_id',true),'') IS NOT NULL OR workflow_evidence_envelope_visible(w,jsonb_build_object('workspaceId',w,
   'userId',dependency.user_id,'assistantId',dependency.assistant_id,'sensitivity',dependency.sensitivity,
   'compartments',dependency.compartments,'projectIds',dependency.project_ids)) IS NOT TRUE THEN RETURN jsonb_build_object('value',false,'memo',memo);END IF;
 END LOOP;
 -- An explicit raw entity source consumes the complete current field mask,
 -- unlike the selected native anchors of a field projection.
 FOR dependency IN SELECT DISTINCT edge.source_id FROM scope_derivation_sources edge JOIN scope_derivations d
  ON d.workspace_id=edge.workspace_id AND d.id=edge.derivation_id JOIN jsonb_array_elements(nodes) ancestor(value)
  ON d.resource_kind=ancestor.value->>'kind' AND d.resource_id=(ancestor.value->>'id')::uuid
  WHERE d.workspace_id=w AND edge.source_kind='entity' LOOP
  SELECT kind INTO type_key FROM entities WHERE workspace_id=w AND id=dependency.source_id;
  IF NOT FOUND OR type_key NOT IN('company','person','deal') THEN CONTINUE;END IF;
  policy:=application_native_field_contract_for(w,'{"kind":"native","moduleKey":"native"}',type_key,dependency.source_id::text);
  IF policy->>'registered' IS DISTINCT FROM 'false' THEN
   mask:=application_current_native_field_policy(w,'{"kind":"native","moduleKey":"native"}',type_key,dependency.source_id);
   IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false' OR mask->>'held' IS DISTINCT FROM 'false'
    OR NOT coalesce(policy#>'{metadata,fieldKeys}'<@(mask->'readFields'),false) THEN RETURN jsonb_build_object('value',false,'memo',memo);END IF;
  END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO refs FROM (SELECT DISTINCT value FROM jsonb_array_elements(refs)) unique_refs;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n JOIN application_field_resources f ON f.workspace_id=w AND f.id=(n->>'id')::uuid
  WHERE n->>'kind'='application_field' AND (f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR f.type_key NOT IN('session_message','session_message_annotation'))) THEN
  memo:=memo-key;
 ELSE memo:=memo||jsonb_build_object(key,jsonb_build_object('value',true,'external',refs)); END IF;RETURN jsonb_build_object('value',true,'memo',memo);
END $function$
;

CREATE OR REPLACE FUNCTION public.application_session_eval_envelope(w uuid, t text, i uuid, selection text, fields text[], memo jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE result jsonb;state jsonb;scope jsonb;identity_value text;resource uuid;version_value text;sources jsonb:='[]';children jsonb:='[]';child jsonb;external record;keys text[];
 origin constant jsonb:='{"kind":"native","moduleKey":"native"}';
BEGIN
 IF (t NOT IN('session_message','session_message_annotation') AND NOT(t='memory' AND coalesce(memo#>>'{memoryStatement,workspaceId}'=w::text,false))) OR selection NOT IN('read','query','identity','query_domain') THEN RETURN jsonb_build_object('memo',memo);END IF;
 keys:=ARRAY(SELECT DISTINCT key FROM unnest(fields) key ORDER BY key);
 IF fields IS NULL OR cardinality(keys)<>cardinality(fields) THEN RETURN jsonb_build_object('memo',memo);END IF;
 IF t='memory' THEN
  state:=CASE WHEN selection='query_domain' THEN application_memory_statement_domain(w,i,keys,memo->'memoryStatement') ELSE application_memory_statement_state(w,i,keys,memo->'memoryStatement') END;
  IF state IS NULL THEN RETURN jsonb_build_object('memo',memo);END IF;
  RETURN jsonb_build_object('memo',memo,'value',application_memory_statement_envelope(w,origin,t,i,selection,NULL,keys,0,state));
 END IF;
 IF selection='query_domain' THEN result:=application_session_eval_domain(w,t,i,keys,memo);children:=coalesce(result->'children','[]'::jsonb);
 ELSE result:=application_session_eval_point_state(w,t,i,keys,memo);END IF;
 memo:=coalesce(result->'memo',memo);state:=result->'value';
 IF state IS NULL OR state='null'::jsonb THEN RETURN jsonb_build_object('memo',memo);END IF;
 scope:=jsonb_build_object('workspaceId',w,'userId',state#>'{source,userId}','assistantId',state#>'{source,assistantId}',
  'sensitivity',state#>'{source,sensitivity}','compartments',state#>'{source,compartments}','projectIds',state#>'{source,projectIds}');
 IF entity_derivation_envelope_valid(scope) IS NOT TRUE THEN RETURN jsonb_build_object('memo',memo);END IF;
 identity_value:=application_field_digest(jsonb_build_object('workspaceId',w,'origin',origin,'typeKey',t,'id',i,
  'selection',selection,'selectedVersion',NULL,'fields',keys,'fieldIdentity',state->'fieldIdentity'));
 resource:=application_field_resource_uuid(identity_value);
 IF memo#>>ARRAY['native:'||(state->>'sourceKind')||':'||(state->>'sourceId')||':'||(state->>'sourceVersion'),'value'] IS DISTINCT FROM 'true'
  OR memo#>ARRAY['native:'||(state->>'sourceKind')||':'||(state->>'sourceId')||':'||(state->>'sourceVersion'),'external'] IS DISTINCT FROM '[]'::jsonb THEN
 FOR external IN SELECT * FROM read_external_source_dependencies(w,ARRAY[state->>'sourceKind'],ARRAY[(state->>'sourceId')::uuid],ARRAY[state->>'sourceVersion']) LOOP
  IF external.source IS NULL OR external.source->>'workspaceId' IS DISTINCT FROM w::text OR external.node_version IS DISTINCT FROM external.source->>'version' THEN RETURN jsonb_build_object('memo',memo);END IF;
  sources:=sources||jsonb_build_array(external.source);
 END LOOP;
 END IF;
 FOR child IN SELECT value FROM jsonb_array_elements(children) LOOP
  sources:=sources||jsonb_build_array(child->'source')||coalesce(child->'sources','[]');
 END LOOP;
 SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO sources FROM (SELECT DISTINCT value FROM jsonb_array_elements(sources)) unique_sources;
 IF jsonb_array_length(sources)>4096 OR jsonb_array_length(children)>4096 THEN RETURN jsonb_build_object('memo',memo);END IF;
 version_value:=application_field_digest(jsonb_build_object('resourceId',resource,'recordVersion',state->'recordVersion',
  'sourceVersion',state->'sourceVersion','policyVersion',state->'policyVersion','scope',scope,'sources',sources));
 RETURN jsonb_build_object('memo',memo,'value',jsonb_build_object('resourceId',resource,'identity',identity_value,'origin',origin,'typeKey',t,'id',i,
  'selection',selection,'selectedVersion',NULL,'fields',keys,'fieldIdentity',state->'fieldIdentity','state',state,'children',children,'sources',sources,
  'source',scope||jsonb_build_object('resourceKind','application_field','resourceId',resource,'version',version_value)));
END $function$
;

CREATE OR REPLACE FUNCTION public.read_native_session_cohort_evidence(w uuid, kinds text[], ids uuid[], versions text[], include_memory boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;nodes jsonb;node jsonb;
 observation application_field_observations;memo jsonb:='{}';result jsonb;current_source jsonb;
 immutable jsonb:='[]';currents jsonb:='[]';dependency record;fresh_nodes jsonb;memory_candidate record;memory_rows jsonb;memory_cohort jsonb;memory_context jsonb;memory_lineage jsonb;memory_source jsonb;
BEGIN
 IF kinds IS NULL OR ids IS NULL OR versions IS NULL OR cardinality(ids) NOT BETWEEN 1 AND 100
  OR cardinality(kinds)<>cardinality(ids) OR cardinality(versions)<>cardinality(ids)
  OR array_position(kinds,NULL) IS NOT NULL OR array_position(ids,NULL) IS NOT NULL OR array_position(versions,NULL) IS NOT NULL THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 -- A changed original evaluator retains its full original fallback contract.
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc
  WHERE oid='public.application_session_eval_scope_current(uuid,text,uuid,text,jsonb)'::regprocedure)
  IS DISTINCT FROM 'b977bab4f04ae2d61d7c7d042225d41a97346466f95352e6f8c8e934bd2a46ca' THEN RETURN NULL;END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])'::regprocedure)
  IS DISTINCT FROM 'decf5058016df0127f14f201c843b311dad798075d3a86ed41071523139c7018' THEN RETURN NULL;END IF;
 -- Every other profile/resource family delegates to the original validator.
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
  OR EXISTS(SELECT 1 FROM unnest(kinds) kind WHERE kind NOT IN('application_field','session_context_revision','session_message','memory')) OR NOT include_memory AND 'memory'=ANY(kinds) THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='session_messages'::regclass WHERE r.rolname=session_user
  AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL;END IF;
 -- Ineligible root metadata adds no native lock or full-closure walk.
 IF EXISTS(SELECT 1 FROM unnest(kinds,ids) root(kind,id)
  LEFT JOIN application_field_resources field ON field.workspace_id=w AND field.id=root.id
  WHERE root.kind='application_field' AND(field.id IS NULL OR field.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb
   OR NOT(field.type_key IN('session_message','session_message_annotation') OR include_memory AND field.type_key='memory'))) THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO nodes FROM application_scope_lineage(w,kinds,ids,versions) n;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind' NOT IN('application_field','application_query_domain','session_context_revision','session_message','memory'))
  OR NOT include_memory AND EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind'='memory')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n LEFT JOIN application_field_resources f ON f.workspace_id=w AND f.id=(n->>'id')::uuid
   WHERE n->>'kind'='application_field' AND(f.id IS NULL OR f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR NOT(f.type_key IN('session_message','session_message_annotation') OR include_memory AND f.type_key='memory'))) THEN RETURN NULL;END IF;
 -- Source-denied physical candidates still require fresh remote cohort
 -- context. No fast-path admission is inferred from the original closure.
 IF EXISTS(SELECT 1 FROM read_native_session_query_cohort_nodes(w,nodes)) THEN RETURN NULL;END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])'::regprocedure)
  IS DISTINCT FROM '8a01f2a9a01cbe613ce23a519610a77e3ae8354bef88df8e99cab0d32bcc2bcd' THEN RETURN NULL;END IF;
 -- Complete current Memory query cohorts cannot hide an independent source.
 -- Metadata is not permission; any independent candidate delegates unchanged.
 IF include_memory THEN
  FOR dependency IN SELECT array_agg(candidate.source->>'resourceKind') AS kinds,
    array_agg((candidate.source->>'resourceId')::uuid) AS ids,array_agg(candidate.source->>'version') AS versions
   FROM read_native_memory_query_cohort_sources(w,kinds,ids,versions) WITH ORDINALITY candidate(source,ord)
   GROUP BY (candidate.ord-1)/100 LOOP
   IF EXISTS(SELECT 1 FROM read_external_source_dependencies(w,dependency.kinds,dependency.ids,dependency.versions)) THEN RETURN NULL;END IF;
  END LOOP;
 END IF;

 PERFORM id FROM workspaces WHERE id=w FOR SHARE;
 IF NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor) THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;

 -- This private argument is created only by this closed SQL operation. It holds
 -- scope metadata, never a Memory business row or a shared selected-field grant.
 IF include_memory AND application_memory_statement_helpers_current() AND (NOT EXISTS(SELECT 1 FROM memories m WHERE m.workspace_id=w AND (
 m.valid_to IS NOT NULL OR m.retracted_at IS NOT NULL OR m.superseded_by IS NOT NULL OR m.source_session_id IS NOT NULL OR m.source_episode_id IS NOT NULL
 OR EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='memory' AND d.resource_id=m.id)
 OR EXISTS(SELECT 1 FROM memories prior WHERE prior.workspace_id=w AND prior.superseded_by=m.id)
 OR EXISTS(SELECT 1 FROM native_memory_successor_transitions t WHERE t.workspace_id=w AND (t.predecessor_id=m.id OR t.successor_id=m.id))))
 AND NOT EXISTS(SELECT 1 FROM application_native_resource_owners o WHERE o.workspace_id=w AND o.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND o.resource_type='memory')
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n JOIN application_field_resources f ON f.workspace_id=w AND f.id=(n->>'id')::uuid WHERE n->>'kind'='application_field' AND f.type_key='memory' AND (
  f.selected_version IS NOT NULL OR f.selection NOT IN('read','query','identity','query_domain')
  OR f.selection<>'query_domain' AND NOT EXISTS(SELECT 1 FROM memories m WHERE m.workspace_id=w AND m.id=f.resource_id)
  OR EXISTS(SELECT 1 FROM application_field_observation_sources s WHERE s.workspace_id=w AND s.resource_id=f.id AND s.version=n->>'version')))
 AND (SELECT count(*) FROM (SELECT id FROM memories WHERE workspace_id=w LIMIT 4097) bounded)<=4096) THEN
  BEGIN
   PERFORM singleton FROM application_policy_contract_epoch WHERE singleton FOR SHARE NOWAIT;
   IF NOT FOUND THEN RAISE EXCEPTION 'memory_statement_unavailable' USING ERRCODE='55P03';END IF;
   PERFORM workspace_id FROM application_policy_workspace_epochs WHERE workspace_id=w FOR SHARE NOWAIT;
   IF NOT FOUND THEN RAISE EXCEPTION 'memory_statement_unavailable' USING ERRCODE='55P03';END IF;
   PERFORM id FROM memories WHERE workspace_id=w ORDER BY id FOR SHARE NOWAIT;
   IF NOT (NOT EXISTS(SELECT 1 FROM memories m WHERE m.workspace_id=w AND (
 m.valid_to IS NOT NULL OR m.retracted_at IS NOT NULL OR m.superseded_by IS NOT NULL OR m.source_session_id IS NOT NULL OR m.source_episode_id IS NOT NULL
 OR EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='memory' AND d.resource_id=m.id)
 OR EXISTS(SELECT 1 FROM memories prior WHERE prior.workspace_id=w AND prior.superseded_by=m.id)
 OR EXISTS(SELECT 1 FROM native_memory_successor_transitions t WHERE t.workspace_id=w AND (t.predecessor_id=m.id OR t.successor_id=m.id))))
 AND NOT EXISTS(SELECT 1 FROM application_native_resource_owners o WHERE o.workspace_id=w AND o.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND o.resource_type='memory')
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n JOIN application_field_resources f ON f.workspace_id=w AND f.id=(n->>'id')::uuid WHERE n->>'kind'='application_field' AND f.type_key='memory' AND (
  f.selected_version IS NOT NULL OR f.selection NOT IN('read','query','identity','query_domain')
  OR f.selection<>'query_domain' AND NOT EXISTS(SELECT 1 FROM memories m WHERE m.workspace_id=w AND m.id=f.resource_id)
  OR EXISTS(SELECT 1 FROM application_field_observation_sources s WHERE s.workspace_id=w AND s.resource_id=f.id AND s.version=n->>'version')))
 AND (SELECT count(*) FROM (SELECT id FROM memories WHERE workspace_id=w LIMIT 4097) bounded)<=4096) THEN RAISE EXCEPTION 'memory_statement_unavailable' USING ERRCODE='55P03';END IF;
   memory_context:=application_memory_query_context(w);
   IF memory_context#>>'{policy,nativeDefault}' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'memory_statement_unavailable' USING ERRCODE='55P03';END IF;
   memory_rows:='{}';memory_cohort:='[]';
   FOR memory_candidate IN SELECT id,scope_version FROM memories WHERE workspace_id=w ORDER BY id LOOP
    SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO memory_lineage FROM application_scope_lineage(w,ARRAY['memory'],ARRAY[memory_candidate.id],ARRAY[memory_candidate.scope_version::text]) n;
    IF memory_lineage IS DISTINCT FROM jsonb_build_array(jsonb_build_object('kind','memory','id',memory_candidate.id,'version',memory_candidate.scope_version::text)) THEN RAISE EXCEPTION 'memory_statement_unavailable' USING ERRCODE='55P03';END IF;
    memory_source:=read_admitted_native_scope_snapshot(w,'memory',memory_candidate.id);
    memory_rows:=memory_rows||jsonb_build_object(memory_candidate.id::text,jsonb_build_object('source',memory_source,'lineage',memory_lineage));
    memory_cohort:=memory_cohort||jsonb_build_array(jsonb_build_object('id',memory_candidate.id,'version',memory_candidate.scope_version::text));
   END LOOP;
   memo:=memo||jsonb_build_object('memoryStatement',jsonb_build_object('workspaceId',w,'context',memory_context,'rows',memory_rows,'cohort',memory_cohort));
  EXCEPTION WHEN lock_not_available THEN memory_rows:=NULL;memory_context:=NULL;memory_cohort:=NULL;
  END;
 END IF;
 -- Read every original field under the current actor and original selector.
 -- Parent/payload/domain checks are inside the unchanged closed evaluator.
 FOR node IN SELECT value FROM jsonb_array_elements(nodes) WHERE value->>'kind'='application_field' ORDER BY value->>'id',value->>'version' LOOP
  SELECT * INTO STRICT observation FROM application_field_observations WHERE workspace_id=w AND resource_id=(node->>'id')::uuid AND version=node->>'version';
  result:=application_session_eval_field(w,(node->>'id')::uuid,node->>'version',memo);memo:=coalesce(result->'memo',memo);current_source:=result->'value';
  IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false' THEN RETURN jsonb_build_object('admitted',false);END IF;
  immutable:=immutable||jsonb_build_array(observation.source_scope||jsonb_build_object('resourceKind','application_field','resourceId',observation.resource_id,'version',observation.version));
  currents:=currents||jsonb_build_array(current_source-ARRAY['held','validTo','retractedAt']);
 END LOOP;
 -- Direct native/context roots and every persistent ancestor retain the same
 -- current native admission, D1 lifecycle and immutable high-water behavior.
 FOR node IN SELECT value FROM jsonb_array_elements(nodes) WHERE value->>'kind' IN('session_message','session_context_revision','memory') ORDER BY value->>'kind',value->>'id',value->>'version' LOOP
  IF node->>'kind'='session_context_revision' AND read_entity_derivation_source(w,node->>'kind',(node->>'id')::uuid) IS NULL THEN
   RETURN jsonb_build_object('admitted',false);END IF;
  current_source:=read_admitted_native_scope_snapshot(w,node->>'kind',(node->>'id')::uuid);
  IF current_source IS NULL THEN
   IF node->>'kind'='session_context_revision' THEN RETURN jsonb_build_object('admitted',false);END IF;
   CONTINUE;
  END IF;
  IF current_source->>'held' IS DISTINCT FROM 'false' THEN RETURN jsonb_build_object('admitted',false);END IF;
  current_source:=jsonb_build_object('workspaceId',w,'userId',current_source->'userId','assistantId',current_source->'assistantId',
   'sensitivity',current_source->'sensitivity','compartments',current_source->'compartments','projectIds',current_source->'projectIds',
   'resourceKind',node->'kind','resourceId',node->'id','version',current_source->'version');
  currents:=currents||jsonb_build_array(current_source);
  IF node->>'kind'='session_context_revision' THEN
   IF current_source->>'version' IS DISTINCT FROM node->>'version' THEN RETURN jsonb_build_object('admitted',false);END IF;
   immutable:=immutable||jsonb_build_array(current_source);
  END IF;
 END LOOP;
 -- Every original derivation envelope still applies, including those on
 -- native ancestors. The full closure contains no raw Entity source; any such
 -- source already delegated above to the unchanged original evaluator.
 FOR dependency IN SELECT DISTINCT d.* FROM scope_derivations d JOIN jsonb_array_elements(nodes) ancestor(value)
  ON d.resource_kind=ancestor.value->>'kind' AND d.resource_id=(ancestor.value->>'id')::uuid WHERE d.workspace_id=w LOOP
  IF workflow_evidence_envelope_visible(w,jsonb_build_object('workspaceId',w,
   'userId',dependency.user_id,'assistantId',dependency.assistant_id,'sensitivity',dependency.sensitivity,
   'compartments',dependency.compartments,'projectIds',dependency.project_ids)) IS NOT TRUE THEN
   RETURN jsonb_build_object('admitted',false);END IF;
 END LOOP;
 -- The evaluator contract is also current at return.
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc
  WHERE oid='public.application_session_eval_scope_current(uuid,text,uuid,text,jsonb)'::regprocedure)
  IS DISTINCT FROM 'b977bab4f04ae2d61d7c7d042225d41a97346466f95352e6f8c8e934bd2a46ca' THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO fresh_nodes FROM application_scope_lineage(w,kinds,ids,versions) n;
 IF nodes IS DISTINCT FROM fresh_nodes THEN RETURN jsonb_build_object('admitted',false);END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])'::regprocedure)
  IS DISTINCT FROM 'decf5058016df0127f14f201c843b311dad798075d3a86ed41071523139c7018' THEN RETURN NULL;END IF;

 IF EXISTS(SELECT 1 FROM read_native_session_query_cohort_nodes(w,fresh_nodes)) THEN RETURN jsonb_build_object('admitted',false);END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])'::regprocedure)
  IS DISTINCT FROM '8a01f2a9a01cbe613ce23a519610a77e3ae8354bef88df8e99cab0d32bcc2bcd' THEN RETURN NULL;END IF;
 -- Complete current Memory query cohorts cannot hide an independent source.
 -- Metadata is not permission; any independent candidate delegates unchanged.
 IF include_memory THEN
  FOR dependency IN SELECT array_agg(candidate.source->>'resourceKind') AS kinds,
    array_agg((candidate.source->>'resourceId')::uuid) AS ids,array_agg(candidate.source->>'version') AS versions
   FROM read_native_memory_query_cohort_sources(w,kinds,ids,versions) WITH ORDINALITY candidate(source,ord)
   GROUP BY (candidate.ord-1)/100 LOOP
   IF EXISTS(SELECT 1 FROM read_external_source_dependencies(w,dependency.kinds,dependency.ids,dependency.versions)) THEN RETURN NULL;END IF;
  END LOOP;
 END IF;


 IF memo ? 'memoryStatement' THEN
  IF application_memory_statement_helpers_current() IS NOT TRUE OR application_memory_query_context(w) IS DISTINCT FROM memory_context OR NOT (NOT EXISTS(SELECT 1 FROM memories m WHERE m.workspace_id=w AND (
 m.valid_to IS NOT NULL OR m.retracted_at IS NOT NULL OR m.superseded_by IS NOT NULL OR m.source_session_id IS NOT NULL OR m.source_episode_id IS NOT NULL
 OR EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='memory' AND d.resource_id=m.id)
 OR EXISTS(SELECT 1 FROM memories prior WHERE prior.workspace_id=w AND prior.superseded_by=m.id)
 OR EXISTS(SELECT 1 FROM native_memory_successor_transitions t WHERE t.workspace_id=w AND (t.predecessor_id=m.id OR t.successor_id=m.id))))
 AND NOT EXISTS(SELECT 1 FROM application_native_resource_owners o WHERE o.workspace_id=w AND o.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND o.resource_type='memory')
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n JOIN application_field_resources f ON f.workspace_id=w AND f.id=(n->>'id')::uuid WHERE n->>'kind'='application_field' AND f.type_key='memory' AND (
  f.selected_version IS NOT NULL OR f.selection NOT IN('read','query','identity','query_domain')
  OR f.selection<>'query_domain' AND NOT EXISTS(SELECT 1 FROM memories m WHERE m.workspace_id=w AND m.id=f.resource_id)
  OR EXISTS(SELECT 1 FROM application_field_observation_sources s WHERE s.workspace_id=w AND s.resource_id=f.id AND s.version=n->>'version')))
 AND (SELECT count(*) FROM (SELECT id FROM memories WHERE workspace_id=w LIMIT 4097) bounded)<=4096) THEN RETURN NULL;END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'version',scope_version::text) ORDER BY id),'[]') INTO memory_cohort FROM memories WHERE workspace_id=w;
  IF memory_cohort IS DISTINCT FROM memo#>'{memoryStatement,cohort}' THEN RETURN NULL;END IF;
  FOR memory_candidate IN SELECT id,scope_version FROM memories WHERE workspace_id=w ORDER BY id LOOP
   memory_source:=read_admitted_native_scope_snapshot(w,'memory',memory_candidate.id);
   SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO memory_lineage FROM application_scope_lineage(w,ARRAY['memory'],ARRAY[memory_candidate.id],ARRAY[memory_candidate.scope_version::text]) n;
   IF memory_source IS DISTINCT FROM memory_rows#>ARRAY[memory_candidate.id::text,'source'] OR memory_lineage IS DISTINCT FROM memory_rows#>ARRAY[memory_candidate.id::text,'lineage'] THEN RETURN NULL;END IF;
  END LOOP;
 END IF;
 RETURN jsonb_build_object('admitted',true,'immutable',immutable,'current',currents);
END $function$
;

REVOKE ALL ON FUNCTION public.application_memory_statement_state(uuid,uuid,text[],jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN REVOKE ALL ON FUNCTION public.application_memory_statement_state(uuid,uuid,text[],jsonb) FROM app_user;END IF;END $$;
REVOKE ALL ON FUNCTION public.application_memory_statement_scan(uuid,text[],jsonb,boolean,jsonb,jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN REVOKE ALL ON FUNCTION public.application_memory_statement_scan(uuid,text[],jsonb,boolean,jsonb,jsonb) FROM app_user;END IF;END $$;
REVOKE ALL ON FUNCTION public.application_memory_statement_domain(uuid,uuid,text[],jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN REVOKE ALL ON FUNCTION public.application_memory_statement_domain(uuid,uuid,text[],jsonb) FROM app_user;END IF;END $$;
REVOKE ALL ON FUNCTION public.application_memory_statement_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN REVOKE ALL ON FUNCTION public.application_memory_statement_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb) FROM app_user;END IF;END $$;
DO $memory_statement_guard$
DECLARE pins text;definition text;signature text;canonical_owner oid;
BEGIN
 SELECT proowner INTO canonical_owner FROM pg_proc WHERE oid='public.application_memory_field_state_before_successor(uuid,uuid,text[])'::regprocedure;
 FOREACH signature IN ARRAY ARRAY['public.application_memory_statement_state(uuid,uuid,text[],jsonb)','public.application_memory_statement_scan(uuid,text[],jsonb,boolean,jsonb,jsonb)','public.application_memory_statement_domain(uuid,uuid,text[],jsonb)','public.application_memory_statement_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)'] LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO %I',signature,pg_get_userbyid(canonical_owner));
 END LOOP;
 SELECT string_agg(format('(%s::oid,%L::text)',p.oid,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),',' ORDER BY p.oid) INTO pins FROM pg_proc p
  WHERE p.oid=ANY(ARRAY['public.agent_read_scope_allows(text,text[],uuid[])'::regprocedure::oid,'public.agent_scope_grant_allows(text,text[])'::regprocedure::oid,'public.agent_visibility_allows(uuid,uuid,uuid)'::regprocedure::oid,'public.application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)'::regprocedure::oid,'public.application_canonical_ancestry_from_admitted_root(uuid,text,uuid,text,boolean,jsonb)'::regprocedure::oid,'public.application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)'::regprocedure::oid,'public.application_compute_field_envelope_before_module_policy(uuid,jsonb,text,uuid,text,text,text[],integer)'::regprocedure::oid,'public.application_compute_field_envelope_before_query_points(uuid,jsonb,text,uuid,text,text,text[],integer)'::regprocedure::oid,'public.application_compute_field_envelope_before_session_eval(uuid,jsonb,text,uuid,text,text,text[],integer)'::regprocedure::oid,'public.application_field_digest(jsonb)'::regprocedure::oid,'public.application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[])'::regprocedure::oid,'public.application_field_projection_state_before_memory_history(uuid,jsonb,text,uuid,text,text,text[])'::regprocedure::oid,'public.application_field_projection_state_before_memory_query(uuid,jsonb,text,uuid,text,text,text[])'::regprocedure::oid,'public.application_field_resource_uuid(text)'::regprocedure::oid,'public.application_memory_field_keys()'::regprocedure::oid,'public.application_memory_field_state(uuid,uuid,text[])'::regprocedure::oid,'public.application_memory_field_state_before_successor(uuid,uuid,text[])'::regprocedure::oid,'public.application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb)'::regprocedure::oid,'public.application_memory_query_candidate_state(uuid,uuid,text[],jsonb)'::regprocedure::oid,'public.application_memory_query_context(uuid)'::regprocedure::oid,'public.application_memory_query_domain_state(uuid,uuid,text[])'::regprocedure::oid,'public.application_memory_statement_domain(uuid,uuid,text[],jsonb)'::regprocedure::oid,'public.application_memory_statement_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)'::regprocedure::oid,'public.application_memory_statement_scan(uuid,text[],jsonb,boolean,jsonb,jsonb)'::regprocedure::oid,'public.application_memory_statement_state(uuid,uuid,text[],jsonb)'::regprocedure::oid,'public.application_native_catalog_port_valid(regprocedure)'::regprocedure::oid,'public.application_native_field_catalog_for(uuid,jsonb,text)'::regprocedure::oid,'public.application_native_field_contract_before_catalog(uuid,jsonb,text,text)'::regprocedure::oid,'public.application_native_field_contract_for(uuid,jsonb,text,text)'::regprocedure::oid,'public.application_native_field_rule_allows(jsonb,text[])'::regprocedure::oid,'public.application_native_member_field_permissions(uuid,jsonb,uuid)'::regprocedure::oid,'public.application_native_query_bounds(uuid)'::regprocedure::oid,'public.application_native_record_port_valid(regprocedure)'::regprocedure::oid,'public.application_native_same_destination(uuid,text,uuid,text,uuid)'::regprocedure::oid,'public.application_normalize_native_query_bounds(jsonb)'::regprocedure::oid,'public.application_principal_query_bounds(uuid,uuid,boolean)'::regprocedure::oid,'public.application_query_scope_cap(integer,jsonb,jsonb)'::regprocedure::oid,'public.application_query_scope_intersection(jsonb,jsonb)'::regprocedure::oid,'public.application_query_scope_valid(jsonb)'::regprocedure::oid,'public.application_query_set_intersection(jsonb,jsonb)'::regprocedure::oid,'public.application_reader_envelope_visible(uuid,jsonb)'::regprocedure::oid,'public.application_recorded_field_root_capture(uuid,uuid,text,integer)'::regprocedure::oid,'public.application_recorded_field_state_before_record_ancestry(uuid,uuid,text,integer)'::regprocedure::oid,'public.application_recorded_field_state_before_session_eval(uuid,uuid,text,integer)'::regprocedure::oid,'public.application_scope_lineage(uuid,text[],uuid[],text[])'::regprocedure::oid,'public.application_scope_source_edges(uuid,text,uuid,text)'::regprocedure::oid,'public.application_scope_source_edges_before_knowledge_versions(uuid,text,uuid,text)'::regprocedure::oid,'public.application_session_eval_envelope(uuid,text,uuid,text,text[],jsonb)'::regprocedure::oid,'public.application_session_eval_field(uuid,uuid,text,jsonb)'::regprocedure::oid,'public.application_session_eval_scope(uuid,text,uuid,text,jsonb)'::regprocedure::oid,'public.assistant_placement_visible(uuid,uuid)'::regprocedure::oid,'public.department_principal_grant_snapshot(uuid)'::regprocedure::oid,'public.department_read_grants()'::regprocedure::oid,'public.department_read_grants_for(uuid)'::regprocedure::oid,'public.department_row_allows(jsonb,uuid,text,text[],uuid)'::regprocedure::oid,'public.effective_member_read_compartments(uuid,uuid)'::regprocedure::oid,'public.effective_member_team_compartments(uuid,uuid)'::regprocedure::oid,'public.entity_derivation_envelope_valid(jsonb)'::regprocedure::oid,'public.knowledge_version_source_edges(uuid,text,uuid,text)'::regprocedure::oid,'public.legacy_assistant_team_compartments(uuid)'::regprocedure::oid,'public.member_operation_grants(boolean,uuid)'::regprocedure::oid,'public.member_operation_row_allows(jsonb,uuid,text,text[])'::regprocedure::oid,'public.member_operation_scope_allows(uuid,text,text[],boolean)'::regprocedure::oid,'public.member_principal_operation_grants(uuid,boolean,uuid)'::regprocedure::oid,'public.project_member_live(uuid,text,uuid)'::regprocedure::oid,'public.read_admitted_native_scope_snapshot(uuid,text,uuid)'::regprocedure::oid,'public.read_admitted_native_scope_snapshot_before_application_sources(uuid,text,uuid)'::regprocedure::oid,'public.read_admitted_native_scope_snapshot_before_knowledge_versions(uuid,text,uuid)'::regprocedure::oid,'public.read_admitted_native_scope_snapshot_before_persistent_context(uuid,text,uuid)'::regprocedure::oid,'public.read_admitted_native_scope_snapshot_before_public_share(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_application_fields(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_blueprint(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_browser_profile(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_browser_session(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_capture(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_conversation(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_engineering_archive(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_knowledge_source_parent(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_knowledge_versions(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_memory_successor(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_page(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_persistent_context(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_primitive_v2(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_recordings(uuid,text,uuid)'::regprocedure::oid,'public.read_entity_derivation_source_before_workflow_run(uuid,text,uuid)'::regprocedure::oid,'public.read_external_source_dependencies(uuid,text[],uuid[],text[])'::regprocedure::oid,'public.read_media_parent_snapshot(uuid,text,uuid)'::regprocedure::oid,'public.read_media_parent_snapshot_before_blueprint(uuid,text,uuid)'::regprocedure::oid,'public.read_media_parent_snapshot_before_browser_profile(uuid,text,uuid)'::regprocedure::oid,'public.read_media_parent_snapshot_before_browser_session(uuid,text,uuid)'::regprocedure::oid,'public.read_media_parent_snapshot_before_conversation(uuid,text,uuid)'::regprocedure::oid,'public.read_media_parent_snapshot_before_page(uuid,text,uuid)'::regprocedure::oid,'public.read_media_parent_snapshot_before_primitive_v2(uuid,text,uuid)'::regprocedure::oid,'public.read_media_parent_snapshot_before_workflow_run(uuid,text,uuid)'::regprocedure::oid,'public.read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])'::regprocedure::oid,'public.read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure::oid,'public.read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])'::regprocedure::oid,'public.read_resource_page_dependencies(uuid,text,uuid,text)'::regprocedure::oid,'public.read_scope_source(uuid,text,uuid)'::regprocedure::oid,'public.read_scope_source_before_application_fields(uuid,text,uuid)'::regprocedure::oid,'public.read_scope_source_before_browser_profile(uuid,text,uuid)'::regprocedure::oid,'public.read_scope_source_before_browser_session(uuid,text,uuid)'::regprocedure::oid,'public.read_scope_source_before_external(uuid,text,uuid)'::regprocedure::oid,'public.read_scope_source_before_knowledge_binding(uuid,text,uuid)'::regprocedure::oid,'public.read_scope_source_before_page(uuid,text,uuid)'::regprocedure::oid,'public.read_scope_source_before_persistent_context(uuid,text,uuid)'::regprocedure::oid,'public.read_scope_source_before_routines(uuid,text,uuid)'::regprocedure::oid,'public.read_scope_source_before_workflow_run(uuid,text,uuid)'::regprocedure::oid,'public.scope_review_state_held(text,uuid)'::regprocedure::oid,'public.scope_source_ancestors(uuid,text,uuid)'::regprocedure::oid,'public.scope_source_ancestors_before_browser_profile(uuid,text,uuid)'::regprocedure::oid,'public.scope_source_ancestors_before_browser_session(uuid,text,uuid)'::regprocedure::oid,'public.scope_source_ancestors_before_workflow_run(uuid,text,uuid)'::regprocedure::oid,'public.scope_source_table(text)'::regprocedure::oid,'public.scope_source_table_before_knowledge_versions(text)'::regprocedure::oid,'public.scope_source_table_before_media(text)'::regprocedure::oid,'public.scope_source_table_before_persistent_context(text)'::regprocedure::oid,'public.sensitivity_rank(text)'::regprocedure::oid,'public.workflow_evidence_envelope_visible(uuid,jsonb)'::regprocedure::oid]);
 definition:='CREATE FUNCTION public.application_memory_statement_helpers_current() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $guard$ SELECT count(*)=120 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false) FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid $guard$';
 EXECUTE definition;
 EXECUTE format('ALTER FUNCTION public.application_memory_statement_helpers_current() OWNER TO %I',pg_get_userbyid(canonical_owner));
END $memory_statement_guard$;
REVOKE ALL ON FUNCTION public.application_memory_statement_helpers_current() FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN REVOKE ALL ON FUNCTION public.application_memory_statement_helpers_current() FROM app_user;END IF;END $$;
COMMIT;
