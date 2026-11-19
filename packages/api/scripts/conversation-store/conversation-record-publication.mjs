// [COMP:api/conversation-visibility] Source transformations of the canonical
// publication and reference validation executables. The successor's frozen
// installation authenticates their complete original catalog contracts first.
const literal=value=>"'"+value.replaceAll("'","''")+"'"

const publicationPatches=[
 ["'application_field','external_source','crm_event','private_transcript','page_event_changed'",
  "'application_field','external_source','crm_event','private_transcript','conversation_record','page_event_changed'"],
 ["FROM jsonb_array_elements(compiled) c CROSS JOIN LATERAL jsonb_array_elements(c->'expanded') n",
  "FROM jsonb_array_elements(compiled) c CROSS JOIN LATERAL jsonb_array_elements(c->'expanded') n\n  WHERE n->>'resourceKind'<>'conversation_record'"],
 ["  ELSIF node->>'resourceKind'='external_source' THEN",
  "  ELSIF node->>'resourceKind'='conversation_record' THEN\n   current_source:=public.conversation_record_publication_source(w,(node->>'resourceId')::uuid,s,actor,coalesce(command->>'purpose'='session_title',false));\n  ELSIF node->>'resourceKind'='external_source' THEN"],
 ["'application_field','external_source','session_context_revision','crm_event','private_transcript'",
  "'application_field','external_source','session_context_revision','crm_event','private_transcript','conversation_record'",2],
 [" source_scope:=jsonb_build_object('workspaceId',w,'userId',target->'userId'",
  ` IF EXISTS(SELECT 1 FROM jsonb_array_elements(sources) origin WHERE origin->>'resourceKind'='conversation_record')
  AND NOT EXISTS(SELECT 1 FROM public.conversation_envelopes e WHERE e.session_id=s AND e.workspace_id=w
   AND sensitivity_rank(floor_tier)<=sensitivity_rank(e.cap) AND teams<@e.compartments
   AND projects<@public.conversation_hard_project_ids(e.compartments))
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 source_scope:=jsonb_build_object('workspaceId',w,'userId',target->'userId'`],
]
const referencePatches=[
 ["  source_row=CASE WHEN TG_TABLE_NAME='scope_resource_states'",
  `  IF TG_TABLE_NAME='scope_derivation_sources' AND expected_kind='conversation_record' THEN
    PERFORM public.require_conversation_record_edge(NEW.workspace_id,NEW.derivation_id,expected_id,expected_version);
    RETURN NEW;
  END IF;
  source_row=CASE WHEN TG_TABLE_NAME='scope_resource_states'`],
]
const manifestPatches=[
 ["'application_field','external_source','crm_event','private_transcript','page_event_changed'",
  "'application_field','external_source','crm_event','private_transcript','conversation_record','page_event_changed'"],
 ["   IF n-ARRAY['workspaceId'",
  `   IF n->>'resourceKind'='conversation_record' AND (n->>'version' IS DISTINCT FROM '1'
    OR n->>'userId' IS NOT NULL OR n->>'assistantId' IS NOT NULL) THEN RETURN false;END IF;
   IF n-ARRAY['workspaceId'`],
]
const compiledPairPatches=[
 ["'application_field','external_source','crm_event','private_transcript','page_event_changed'",
  "'application_field','external_source','crm_event','private_transcript','conversation_record','page_event_changed'"],
 ["  IF n.workspace_id IS DISTINCT FROM w",
  `  IF n.kind='conversation_record' AND (n.version IS DISTINCT FROM '1'
   OR n.user_id IS NOT NULL OR n.assistant_id IS NOT NULL) THEN RETURN false;END IF;
  IF n.workspace_id IS DISTINCT FROM w`],
]
export const recordPublicationChanges=Object.freeze({
 'conversation_prepare_publications(uuid,uuid,jsonb)':publicationPatches,
 'validate_scope_resource_reference()':referencePatches,
 'native_turn_frame_payload_shape(jsonb)':manifestPatches,
 'native_conversation_compiled_frame_pair(uuid,uuid)':compiledPairPatches,
})

/** Compile only the finite, reviewed replacement sites against predecessor
 * source. Produces the same result for authentication and installation. */
export function recordPublicationRendererSql(name,predecessor){
 const cases=Object.entries(recordPublicationChanges).map(([signature,patches])=>
  `WHEN ${literal(signature)} THEN
   ${patches.map(([before,after,count=1])=>`marker:=${literal(before)};
   IF (length(body)-length(replace(body,marker,'')))/length(marker)<>${count} THEN
    RAISE EXCEPTION 'conversation_record_publication_predecessor_changed: %',signature;END IF;
   body:=replace(body,marker,${literal(after)});`).join('\n   ')}`).join('\n  ')
 return `CREATE FUNCTION pg_temp.${name}(signature text,template jsonb,successor boolean) RETURNS text
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $record_publication_renderer$
 DECLARE body text:=pg_temp.${predecessor}(signature,template,successor);marker text;
 BEGIN
 CASE signature
  ${cases}
  ELSE NULL;
 END CASE;
 RETURN body;
 END $record_publication_renderer$;`
}

export function recordPublicationConstraintSql(){
 // 8011 defines the roster. 8054 and 8079 append two kinds to its expression;
 // 8227 and 8234 each prepend one kind. Use PostgreSQL's identical deparser on
 // this reviewed expression so the installer never learns an installed CHECK.
 const base=`source_kind IN ('memory','entity','entity_link','task','workspace_file','episode','knowledge_entry','kb_chunk',
  'crm_event','memory_verification','brain_verification','correction_audit','session_message','feedback_event','workspace_skill_revision',
  'knowledge_source','recording','file_segment','transcript_segment','blueprint_record','browser_profile','browser_session','workflow_run',
  'page_event_changed','page_event_destination','page_live_changed','page_live_destination','external_source','application_field')`
 const predecessor=`source_kind='private_transcript' OR (source_kind='office_observation' OR
  (((${base}) OR source_kind='session_context_revision') OR source_kind='knowledge_entry_revision'))`
 return `CREATE TEMP TABLE record_publication_reviewed_constraint(source_kind text,
  CONSTRAINT reviewed_kind CHECK (${predecessor})) ON COMMIT DROP;
 DO $record_publication_constraint$ DECLARE definition text;expected text;BEGIN
 SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
 WHERE conrelid='public.scope_derivation_sources'::regclass AND conname='scope_derivation_sources_source_kind_check'
  AND contype='c' AND convalidated AND NOT connoinherit;
 SELECT pg_get_constraintdef(oid) INTO STRICT expected FROM pg_constraint
 WHERE conrelid='pg_temp.record_publication_reviewed_constraint'::regclass AND conname='reviewed_kind';
 IF definition IS DISTINCT FROM expected THEN RAISE EXCEPTION 'conversation_record_source_constraint_changed';END IF;
 ALTER TABLE public.scope_derivation_sources DROP CONSTRAINT scope_derivation_sources_source_kind_check;
 ALTER TABLE public.scope_derivation_sources ADD CONSTRAINT scope_derivation_sources_source_kind_check
  CHECK (source_kind='conversation_record' OR (${predecessor}));
 END $record_publication_constraint$;`
}
