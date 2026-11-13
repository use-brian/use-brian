-- [COMP:api/native-chat-read-cost] Admit canonical recording ancestry within one bounded native proof.
-- The canonical media readers retain all source-specific authority and exact-version checks.
BEGIN;
DO $native_media_ancestry$
DECLARE expected jsonb;edit jsonb;signature text;ok boolean;target regprocedure;routine pg_proc;
 original text;successor text;old_fingerprint text;new_fingerprint text;
BEGIN
 FOREACH signature IN ARRAY ARRAY['native_turn_helpers_current()','native_turn_publication_contract()',
  'application_native_worklist_helpers_current()','application_native_dependency_batch_helpers_current()',
  'application_native_field_reference_helpers_current()','application_memory_statement_helpers_current()'] LOOP
  EXECUTE 'SELECT public.'||signature INTO ok;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'native_media_ancestry_dependency_changed: %',signature;END IF;
 END LOOP;
 FOR expected IN SELECT value FROM jsonb_array_elements($media_changes$
[
 {
  "sig": "native_turn_capture_sources(uuid,jsonb)",
  "sha": "4e2edd83e360644a68f9e85c1c52445dfd48b5c55cb4ffecbca91d54c7a7db88",
  "edits": [
   {
    "before": "member_role text;v2 boolean;n jsonb;m jsonb;source jsonb;",
    "after": "member_role text;v2 boolean;n jsonb;m jsonb;source jsonb;canonical_source jsonb;"
   },
   {
    "before": "  IF m->>'exists' IS DISTINCT FROM 'true'",
    "after": "\n  IF n#>>'{node,kind}' IN('episode','recording') OR n#>>'{metadata,hasDerivation}'='true' THEN\n   canonical_source:=read_admitted_native_scope_snapshot(w,n#>>'{node,kind}',(n#>>'{node,id}')::uuid);\n   IF canonical_source IS NULL OR canonical_source-ARRAY['causalEntityId'] IS DISTINCT FROM source-ARRAY['resourceKind','resourceId']\n    OR read_entity_derivation_source(w,n#>>'{node,kind}',(n#>>'{node,id}')::uuid) IS NULL THEN RETURN NULL;END IF;\n  END IF;\n  IF m->>'exists' IS DISTINCT FROM 'true'"
   },
   {
    "before": "  ELSE RETURN NULL;END IF;",
    "after": "  ELSIF n#>>'{node,kind}' IN('episode','recording') THEN\n   IF canonical_source IS NULL THEN RETURN NULL;END IF;\n  ELSE RETURN NULL;END IF;"
   }
  ],
  "metadata": {
   "probin": null,
   "procost": 100,
   "prokind": "f",
   "proname": "native_turn_capture_sources",
   "prorows": 0,
   "pronargs": 2,
   "proconfig": [
    "search_path=pg_catalog, public, pg_temp"
   ],
   "proretset": false,
   "prosecdef": true,
   "prorettype": "3802",
   "prosqlbody": null,
   "prosupport": "-",
   "proargmodes": null,
   "proargnames": [
    "w",
    "meta"
   ],
   "proargtypes": [
    "2950",
    "3802"
   ],
   "proisstrict": false,
   "proparallel": "u",
   "protrftypes": null,
   "provariadic": "0",
   "provolatile": "s",
   "proleakproof": false,
   "proallargtypes": null,
   "pronargdefaults": 0
  }
 },
 {
  "sig": "native_turn_lock_requirements(uuid,jsonb)",
  "sha": "0942ed7b73b95ebe4c49a52bc440b553610ba5cfc81f31b73717d5b5f165d5fd",
  "edits": [
   {
    "before": "  ELSE RETURN false;END IF;",
    "after": "  ELSIF node.kind='episode' THEN PERFORM id FROM episodes WHERE workspace_id=w AND id=node.id FOR SHARE;\n  ELSIF node.kind='recording' THEN PERFORM id FROM recordings WHERE workspace_id=w AND id=node.id FOR SHARE;\n  ELSE RETURN false;END IF;"
   },
   {
    "before": " PERFORM singleton FROM application_policy_contract_epoch",
    "after": " PERFORM recording_id FROM recording_intake_bindings WHERE workspace_id=w AND recording_id IN(\n  SELECT (n#>>'{node,id}')::uuid FROM jsonb_array_elements(meta#>'{witness,nativeMetadata}') n WHERE n#>>'{node,kind}'='recording') ORDER BY recording_id FOR SHARE NOWAIT;\n PERFORM singleton FROM application_policy_contract_epoch"
   }
  ],
  "metadata": {
   "probin": null,
   "procost": 100,
   "prokind": "f",
   "proname": "native_turn_lock_requirements",
   "prorows": 0,
   "pronargs": 2,
   "proconfig": [
    "search_path=pg_catalog, public, pg_temp"
   ],
   "proretset": false,
   "prosecdef": true,
   "prorettype": "16",
   "prosqlbody": null,
   "prosupport": "-",
   "proargmodes": null,
   "proargnames": [
    "w",
    "meta"
   ],
   "proargtypes": [
    "2950",
    "3802"
   ],
   "proisstrict": false,
   "proparallel": "u",
   "protrftypes": null,
   "provariadic": "0",
   "provolatile": "v",
   "proleakproof": false,
   "proallargtypes": null,
   "pronargdefaults": 0
  }
 },
 {
  "sig": "native_turn_discover_lock_requirements(uuid,jsonb,jsonb)",
  "sha": "9874c70dab66e24e3e4314d18556b451b5b107d854d126fd6d71d7d1d3329bae",
  "edits": [
   {
    "before": " reasons text[]:='{}';step integer:=0;counts jsonb;",
    "after": " reasons text[]:='{}';step integer:=0;counts jsonb;media_node jsonb;media_lineage jsonb;media_graph jsonb;"
   },
   {
    "before": "n->>'kind' NOT IN('application_field','application_query_domain','session_message','session_context_revision','workspace_file')",
    "after": "n->>'kind' NOT IN('application_field','application_query_domain','session_message','session_context_revision','workspace_file','episode','recording')"
   },
   {
    "before": "n->>'kind' NOT IN('session','application_field','application_query_domain','session_message','session_context_revision','workspace_file')",
    "after": "n->>'kind' NOT IN('session','application_field','application_query_domain','session_message','session_context_revision','workspace_file','episode','recording')"
   },
   {
    "before": " ) SELECT coalesce(jsonb_agg(jsonb_build_object('node',node,'metadata',metadata) ORDER BY node::text),'[]') INTO native_metadata FROM rows;",
    "after": "\n UNION ALL SELECT value,jsonb_build_object('exists',e.id IS NOT NULL,'id',e.id,'workspaceId',e.workspace_id,'userId',e.user_id,'assistantId',e.assistant_id,\n  'version',e.scope_version::text,'held',e.scope_held,'sensitivity',e.sensitivity,'compartments',e.compartments,'projectIds',e.project_ids,\n  'validTo',NULL,'retractedAt',NULL,'sourceKind',e.source_kind)\n FROM n LEFT JOIN episodes e ON e.workspace_id=w AND e.id=(value->>'id')::uuid WHERE value->>'kind'='episode'\n UNION ALL SELECT value,jsonb_build_object('exists',r.id IS NOT NULL,'id',r.id,'workspaceId',r.workspace_id,'userId',r.user_id,'assistantId',r.assistant_id,\n  'version',r.scope_version::text,'held',r.scope_held,'sensitivity',r.sensitivity,'compartments',r.compartments,'projectIds',r.project_ids,\n  'validTo',r.valid_to,'retractedAt',r.retracted_at,'mediaFileId',r.media_file_id,'binding',(SELECT jsonb_build_object(\n   'recordingId',b.recording_id,'workspaceId',b.workspace_id,'fileId',b.file_id,'fileVersion',b.file_version,'supersededBy',b.superseded_by)\n   FROM recording_intake_bindings b WHERE b.workspace_id=w AND b.recording_id=r.id))\n FROM n LEFT JOIN recordings r ON r.workspace_id=w AND r.id=(value->>'id')::uuid WHERE value->>'kind'='recording'\n ) SELECT coalesce(jsonb_agg(jsonb_build_object('node',node,'metadata',metadata) ORDER BY node::text),'[]') INTO native_metadata FROM rows;\n -- Canonical media is an opaque primitive subtree, never a field/policy shortcut.\n FOR media_node IN SELECT value FROM jsonb_array_elements(native_metadata) n\n  WHERE n#>>'{node,kind}' IN('episode','recording') OR n#>>'{metadata,hasDerivation}'='true' LOOP\n  IF media_node#>>'{node,kind}'='episode' AND (media_node#>>'{metadata,sourceKind}' IS DISTINCT FROM 'recording'\n   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(native_metadata) peer WHERE peer#>>'{node,kind}'='recording'\n    AND peer#>>'{node,id}'=media_node#>>'{node,id}'))\n   OR media_node#>>'{node,kind}'='recording' AND (media_node#>'{metadata,binding}' IS NULL OR media_node#>'{metadata,binding}'='null'::jsonb\n    OR media_node#>>'{metadata,binding,supersededBy}' IS NOT NULL\n    OR media_node#>>'{metadata,binding,fileId}' IS DISTINCT FROM media_node#>>'{metadata,mediaFileId}'\n    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(native_metadata) peer WHERE peer#>>'{node,kind}'='episode'\n     AND peer#>>'{node,id}'=media_node#>>'{node,id}')) THEN\n   RETURN jsonb_build_object('eligibleMetadata',false,'authorizationEvaluated',false,'reason','unsupported_media_metadata');END IF;\n  SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO media_lineage\n   FROM application_scope_lineage(w,ARRAY[media_node#>>'{node,kind}'],ARRAY[(media_node#>>'{node,id}')::uuid],ARRAY[media_node#>>'{node,version}']) n;\n  IF EXISTS(SELECT 1 FROM jsonb_array_elements(media_lineage) n WHERE n->>'kind' NOT IN('workspace_file','episode','recording')) THEN\n   RETURN jsonb_build_object('eligibleMetadata',false,'authorizationEvaluated',false,'reason','unsupported_media_ancestry');END IF;\n  WITH RECURSIVE physical(n) AS (\n   SELECT media_node->'node'\n   UNION SELECT e->'child' FROM physical p JOIN jsonb_array_elements(edges) e ON e->'parent'=p.n\n  ) SELECT coalesce(jsonb_agg(n-'tag' ORDER BY n->>'kind',n->>'id',n->>'version'),'[]') INTO media_graph FROM physical;\n  IF media_graph IS DISTINCT FROM media_lineage THEN RETURN jsonb_build_object('eligibleMetadata',false,'authorizationEvaluated',false,'reason','media_ancestry_coverage');END IF;\n END LOOP;\n"
   },
   {
    "before": "n#>>'{metadata,purpose}'='engineering_archive' OR n#>>'{metadata,hasDerivation}'='true'",
    "after": "n#>>'{metadata,purpose}'='engineering_archive'"
   }
  ],
  "metadata": {
   "probin": null,
   "procost": 100,
   "prokind": "f",
   "proname": "native_turn_discover_lock_requirements",
   "prorows": 0,
   "pronargs": 3,
   "proconfig": [
    "search_path=pg_catalog, public, pg_temp"
   ],
   "proretset": false,
   "prosecdef": true,
   "prorettype": "3802",
   "prosqlbody": null,
   "prosupport": "-",
   "proargmodes": null,
   "proargnames": [
    "w",
    "roots",
    "selectors"
   ],
   "proargtypes": [
    "2950",
    "3802",
    "3802"
   ],
   "proisstrict": false,
   "proparallel": "u",
   "protrftypes": null,
   "provariadic": "0",
   "provolatile": "s",
   "proleakproof": false,
   "proallargtypes": null,
   "pronargdefaults": 0
  }
 },
 {
  "sig": "native_turn_compact_metadata(uuid,jsonb,jsonb)",
  "sha": "69b20609918b86aa409fb56dbc2d8dc5f4dac768a0824ea803dc9059f3f03a81",
  "edits": [
   {
    "before": " reasons text[]:='{}';step integer:=0;counts jsonb;",
    "after": " reasons text[]:='{}';step integer:=0;counts jsonb;media_node jsonb;media_lineage jsonb;media_graph jsonb;"
   },
   {
    "before": "n->>'kind' NOT IN('application_field','application_query_domain','session_message','session_context_revision','workspace_file')",
    "after": "n->>'kind' NOT IN('application_field','application_query_domain','session_message','session_context_revision','workspace_file','episode','recording')"
   },
   {
    "before": "n->>'kind' NOT IN('session','application_field','application_query_domain','session_message','session_context_revision','workspace_file')",
    "after": "n->>'kind' NOT IN('session','application_field','application_query_domain','session_message','session_context_revision','workspace_file','episode','recording')"
   },
   {
    "before": " ) SELECT coalesce(jsonb_agg(jsonb_build_object('node',node,'metadata',metadata) ORDER BY node::text),'[]') INTO native_metadata FROM rows;",
    "after": "\n UNION ALL SELECT value,jsonb_build_object('exists',e.id IS NOT NULL,'id',e.id,'workspaceId',e.workspace_id,'userId',e.user_id,'assistantId',e.assistant_id,\n  'version',e.scope_version::text,'held',e.scope_held,'sensitivity',e.sensitivity,'compartments',e.compartments,'projectIds',e.project_ids,\n  'validTo',NULL,'retractedAt',NULL,'sourceKind',e.source_kind)\n FROM n LEFT JOIN episodes e ON e.workspace_id=w AND e.id=(value->>'id')::uuid WHERE value->>'kind'='episode'\n UNION ALL SELECT value,jsonb_build_object('exists',r.id IS NOT NULL,'id',r.id,'workspaceId',r.workspace_id,'userId',r.user_id,'assistantId',r.assistant_id,\n  'version',r.scope_version::text,'held',r.scope_held,'sensitivity',r.sensitivity,'compartments',r.compartments,'projectIds',r.project_ids,\n  'validTo',r.valid_to,'retractedAt',r.retracted_at,'mediaFileId',r.media_file_id,'binding',(SELECT jsonb_build_object(\n   'recordingId',b.recording_id,'workspaceId',b.workspace_id,'fileId',b.file_id,'fileVersion',b.file_version,'supersededBy',b.superseded_by)\n   FROM recording_intake_bindings b WHERE b.workspace_id=w AND b.recording_id=r.id))\n FROM n LEFT JOIN recordings r ON r.workspace_id=w AND r.id=(value->>'id')::uuid WHERE value->>'kind'='recording'\n ) SELECT coalesce(jsonb_agg(jsonb_build_object('node',node,'metadata',metadata) ORDER BY node::text),'[]') INTO native_metadata FROM rows;\n -- Canonical media is an opaque primitive subtree, never a field/policy shortcut.\n FOR media_node IN SELECT value FROM jsonb_array_elements(native_metadata) n\n  WHERE n#>>'{node,kind}' IN('episode','recording') OR n#>>'{metadata,hasDerivation}'='true' LOOP\n  IF media_node#>>'{node,kind}'='episode' AND (media_node#>>'{metadata,sourceKind}' IS DISTINCT FROM 'recording'\n   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(native_metadata) peer WHERE peer#>>'{node,kind}'='recording'\n    AND peer#>>'{node,id}'=media_node#>>'{node,id}'))\n   OR media_node#>>'{node,kind}'='recording' AND (media_node#>'{metadata,binding}' IS NULL OR media_node#>'{metadata,binding}'='null'::jsonb\n    OR media_node#>>'{metadata,binding,supersededBy}' IS NOT NULL\n    OR media_node#>>'{metadata,binding,fileId}' IS DISTINCT FROM media_node#>>'{metadata,mediaFileId}'\n    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(native_metadata) peer WHERE peer#>>'{node,kind}'='episode'\n     AND peer#>>'{node,id}'=media_node#>>'{node,id}')) THEN\n   RETURN jsonb_build_object('eligibleMetadata',false,'authorizationEvaluated',false,'reason','unsupported_media_metadata');END IF;\n  SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO media_lineage\n   FROM application_scope_lineage(w,ARRAY[media_node#>>'{node,kind}'],ARRAY[(media_node#>>'{node,id}')::uuid],ARRAY[media_node#>>'{node,version}']) n;\n  IF EXISTS(SELECT 1 FROM jsonb_array_elements(media_lineage) n WHERE n->>'kind' NOT IN('workspace_file','episode','recording')) THEN\n   RETURN jsonb_build_object('eligibleMetadata',false,'authorizationEvaluated',false,'reason','unsupported_media_ancestry');END IF;\n  WITH RECURSIVE physical(n) AS (\n   SELECT media_node->'node'\n   UNION SELECT e->'child' FROM physical p JOIN jsonb_array_elements(edges) e ON e->'parent'=p.n\n  ) SELECT coalesce(jsonb_agg(n-'tag' ORDER BY n->>'kind',n->>'id',n->>'version'),'[]') INTO media_graph FROM physical;\n  IF media_graph IS DISTINCT FROM media_lineage THEN RETURN jsonb_build_object('eligibleMetadata',false,'authorizationEvaluated',false,'reason','media_ancestry_coverage');END IF;\n END LOOP;\n"
   },
   {
    "before": "n#>>'{metadata,purpose}'='engineering_archive' OR n#>>'{metadata,hasDerivation}'='true'",
    "after": "n#>>'{metadata,purpose}'='engineering_archive'"
   }
  ],
  "metadata": {
   "probin": null,
   "procost": 100,
   "prokind": "f",
   "proname": "native_turn_compact_metadata",
   "prorows": 0,
   "pronargs": 3,
   "proconfig": [
    "search_path=pg_catalog, public, pg_temp"
   ],
   "proretset": false,
   "prosecdef": true,
   "prorettype": "3802",
   "prosqlbody": null,
   "prosupport": "-",
   "proargmodes": null,
   "proargnames": [
    "w",
    "roots",
    "selectors"
   ],
   "proargtypes": [
    "2950",
    "3802",
    "3802"
   ],
   "proisstrict": false,
   "proparallel": "u",
   "protrftypes": null,
   "provariadic": "0",
   "provolatile": "s",
   "proleakproof": false,
   "proallargtypes": null,
   "pronargdefaults": 0
  }
 },
 {
  "sig": "native_turn_capture_compact_requirements(uuid,jsonb,jsonb)",
  "sha": "a587a3e12b6aca90b2a78adc1f113f59389099ed0d264ac5264bda60ee40365e",
  "edits": [
   {
    "before": "ELSIF node->>'kind' IN('session_message','session_context_revision','workspace_file') THEN",
    "after": "ELSIF node->>'kind' IN('session_message','session_context_revision','workspace_file','episode','recording') THEN"
   }
  ],
  "metadata": {
   "probin": null,
   "procost": 100,
   "prokind": "f",
   "proname": "native_turn_capture_compact_requirements",
   "prorows": 0,
   "pronargs": 3,
   "proconfig": [
    "search_path=pg_catalog, public, pg_temp"
   ],
   "proretset": false,
   "prosecdef": true,
   "prorettype": "3802",
   "prosqlbody": null,
   "prosupport": "-",
   "proargmodes": null,
   "proargnames": [
    "w",
    "roots",
    "selectors"
   ],
   "proargtypes": [
    "2950",
    "3802",
    "3802"
   ],
   "proisstrict": false,
   "proparallel": "u",
   "protrftypes": null,
   "provariadic": "0",
   "provolatile": "s",
   "proleakproof": false,
   "proallargtypes": null,
   "pronargdefaults": 0
  }
 }
]
$media_changes$::jsonb) LOOP
  target:=to_regprocedure('public.'||(expected->>'sig'));
  SELECT * INTO STRICT routine FROM pg_proc WHERE oid=target;
  original:=routine.prosrc;
  old_fingerprint:=encode(sha256(convert_to(to_jsonb(routine)::text,'UTF8')),'hex');
  IF encode(sha256(convert_to(original,'UTF8')),'hex') IS DISTINCT FROM expected->>'sha'
   OR routine.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass)
   OR routine.pronamespace<>'public'::regnamespace OR routine.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
   OR (to_jsonb(routine)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace','proargdefaults']) IS DISTINCT FROM expected->'metadata'
   OR routine.proargdefaults IS NOT NULL
   OR (SELECT count(*)=1 AND coalesce(bool_and(a.grantee=routine.proowner AND a.grantor=routine.proowner
     AND a.privilege_type='EXECUTE' AND NOT a.is_grantable),false)
    FROM aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) a) IS NOT TRUE
   OR NOT EXISTS(SELECT 1 FROM native_turn_contract_helpers h WHERE h.signature=expected->>'sig' AND h.fingerprint=old_fingerprint)
  THEN RAISE EXCEPTION 'native_media_ancestry_predecessor_changed: %',expected->>'sig';END IF;
  -- These helpers use the canonical registry and have no executable literal pin consumers.
  IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.prokind='f' AND p.oid<>target AND (
    position(quote_literal(original) IN p.prosrc)>0 OR position(old_fingerprint IN p.prosrc)>0
    OR position(expected->>'sha' IN p.prosrc)>0))
  THEN RAISE EXCEPTION 'native_media_ancestry_unexpected_pin_consumer: %',expected->>'sig';END IF;
  successor:=original;
  FOR edit IN SELECT value FROM jsonb_array_elements(expected->'edits') LOOP
   IF (length(successor)-length(replace(successor,edit->>'before','')))/length(edit->>'before')<>1
   THEN RAISE EXCEPTION 'native_media_ancestry_splice_changed: %',expected->>'sig';END IF;
   successor:=replace(successor,edit->>'before',edit->>'after');
  END LOOP;
  EXECUTE replace(pg_get_functiondef(target),original,successor);
  IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=target) IS DISTINCT FROM to_jsonb(routine)-'prosrc'
   OR (SELECT prosrc FROM pg_proc WHERE oid=target) IS DISTINCT FROM successor
  THEN RAISE EXCEPTION 'native_media_ancestry_metadata_changed: %',expected->>'sig';END IF;
  SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO STRICT new_fingerprint FROM pg_proc p WHERE oid=target;
  UPDATE native_turn_contract_helpers h SET fingerprint=new_fingerprint WHERE h.signature=expected->>'sig' AND h.fingerprint=old_fingerprint;
  IF NOT FOUND THEN RAISE EXCEPTION 'native_media_ancestry_registry_changed: %',expected->>'sig';END IF;
 END LOOP;
 FOREACH signature IN ARRAY ARRAY['native_turn_helpers_current()','native_turn_publication_contract()',
  'application_native_worklist_helpers_current()','application_native_dependency_batch_helpers_current()',
  'application_native_field_reference_helpers_current()','application_memory_statement_helpers_current()'] LOOP
  EXECUTE 'SELECT public.'||signature INTO ok;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'native_media_ancestry_successor_changed: %',signature;END IF;
 END LOOP;
END $native_media_ancestry$;
COMMIT;
