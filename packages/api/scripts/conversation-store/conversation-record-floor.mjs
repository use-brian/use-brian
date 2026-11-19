// [COMP:api/conversation-visibility] Separate a private conversation's Project
// association from its actual scope labels at ordinary source and write time.
const literal = value => "'" + value.replaceAll("'", "''") + "'"

const messageBinding = ' IF parent.context_group_id IS NOT NULL THEN'
const parentProjects = "CASE WHEN s.context_project_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(s.context_project_id) END"

export const recordFloorChanges = Object.freeze({
  'conversation_message_snapshot(uuid,uuid,jsonb)': [
    messageBinding,
    ` IF parent.visibility='personal' AND parent.workspace_id=w AND parent.context_project_id IS NOT NULL
  AND EXISTS(SELECT 1 FROM public.conversation_envelopes e
   WHERE e.session_id=parent.id AND e.workspace_id=w AND e.visibility='private_by_kind'
    AND NOT parent.context_project_id=ANY(public.conversation_hard_project_ids(e.compartments))) THEN
  parent.context_project_id:=NULL;
 END IF;
${messageBinding}`,
  ],
  'session_context_parent_snapshot(uuid,uuid)': [
    parentProjects,
    `coalesce((SELECT to_jsonb(public.conversation_hard_project_ids(e.compartments))
   FROM public.conversation_envelopes e WHERE e.session_id=s.id AND e.workspace_id=w
    AND s.visibility='personal' AND e.visibility='private_by_kind'),
   ${parentProjects})`,
  ],
})

export const fusedRecordFloorSignature = 'fused_l_message_snapshot(jsonb,uuid,uuid,jsonb)'
const parentProjection = '   FOR SHARE OF s),\n  grp AS MATERIALIZED'
export const fusedRecordFloorChanges = [
  ['(SELECT context_project_id FROM par)', '(SELECT context_project_id FROM relation_floor)', 5],
  ["CASE WHEN p.context_project_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p.context_project_id) END",
    "coalesce((SELECT jsonb_build_array(context_project_id) FROM relation_floor WHERE context_project_id IS NOT NULL),'[]'::jsonb)", 1],
  [parentProjection, `   FOR SHARE OF s),
  relation_floor AS MATERIALIZED (
   SELECT CASE WHEN p.visibility='personal' AND p.workspace_id=w AND EXISTS(
    SELECT 1 FROM public.conversation_envelopes e WHERE e.session_id=p.id AND e.workspace_id=w
     AND e.visibility='private_by_kind' AND NOT p.context_project_id=ANY(public.conversation_hard_project_ids(e.compartments)))
    THEN NULL ELSE p.context_project_id END context_project_id FROM par p
  ),
  grp AS MATERIALIZED`, 1],
]

export function recordFloorRenderer(name, predecessor) {
  const changes = Object.entries(recordFloorChanges).map(([signature, [before, after]]) =>
    `WHEN ${literal(signature)} THEN
   marker:=${literal(before)};
   IF (length(body)-length(replace(body,marker,'')))/length(marker)<>1 THEN
    RAISE EXCEPTION 'conversation_floor_predecessor_changed: %',signature;
   END IF;
   RETURN replace(body,marker,${literal(after)});`)
  return `CREATE FUNCTION pg_temp.${name}(signature text,parts jsonb,successor boolean) RETURNS text
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $record_floor_renderer$
 DECLARE body text:=pg_temp.${predecessor}(signature,parts,successor);marker text;
 BEGIN
 CASE signature
  ${changes.join('\n  ')}
  ELSE RETURN body;
 END CASE;
 END $record_floor_renderer$;`
}
