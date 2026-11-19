// [COMP:api/native-turn-frame] Admit and retain the exact current Office observation.
const pageKinds = "'page_event_changed','page_event_destination','page_live_changed','page_live_destination'"
const guards = "'application_field','external_source','session_context_revision','crm_event','private_transcript','conversation_record'"
const allowed = "'application_field','external_source','crm_event','private_transcript','conversation_record'"
const addOffice = [`${allowed},${pageKinds}`, `${allowed},'office_observation',${pageKinds}`]
export const replacements = {
  'conversation_dag(uuid,jsonb,jsonb)': [
    [
      " ELSIF kind='session_message' THEN\n    source:=conversation_message_snapshot(",
      ` ELSIF kind='office_observation' THEN
    -- An Office observation binds the unchanged artifact snapshot and its current access.
    -- Take the artifact first, in the same order as the Office policy writers.
    DECLARE artifact uuid;
    BEGIN
     SELECT o.artifact_id INTO artifact FROM public.office_scope_observations o
      WHERE o.workspace_id=w AND o.id=node_id AND o.content_version=node_version AND NOT o.held;
     IF artifact IS NOT NULL THEN
      PERFORM a.id FROM public.office_artifacts a WHERE a.workspace_id=w AND a.id=artifact FOR SHARE;
      IF FOUND THEN
       PERFORM d.artifact_id FROM public.office_collab_documents d WHERE d.workspace_id=w AND d.artifact_id=artifact FOR SHARE;
       source:=public.read_entity_derivation_source(w,kind,node_id);
      END IF;
     END IF;
    END;
    valid:=source IS NOT NULL AND source->>'held'='false' AND source->>'version'=node_version
     AND workflow_evidence_envelope_visible(w,source) IS TRUE;
   ELSIF kind='session_message' THEN
    source:=conversation_message_snapshot(`,
    ],
  ],
  'conversation_prepare_publications(uuid,uuid,jsonb)': [
    addOffice,
    [
      "    FROM jsonb_array_elements(lineage) n WHERE n->>'kind'='session_context_revision'",
      "    FROM jsonb_array_elements(lineage) n WHERE n->>'kind' IN('session_context_revision','office_observation')",
    ],
    [
      `OR node->>'resourceKind' IN(${guards})`,
      `OR node->>'resourceKind' IN(${guards},'office_observation')`,
    ],
    [
      `WHERE obligation.value->>'resourceKind' IN(${guards})`,
      `WHERE obligation.value->>'resourceKind' IN(${guards},'office_observation')`,
    ],
  ],
  'native_turn_frame_payload_shape(jsonb)': [addOffice],
  'native_conversation_compiled_frame_pair(uuid,uuid)': [addOffice],
}
