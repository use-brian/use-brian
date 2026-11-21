// [COMP:api/native-turn-frame] Bound privacy edge reads to the current capture.
import { readFile } from 'node:fs/promises'

// Keep every edge family from the predecessor. The LATERAL boundary keeps the
// recursive term parameterized even when a workspace has a large derivation
// or field-observation history. Both directions still use the same edges.
const adjacent = (relation, node) => `CROSS JOIN LATERAL (
   SELECT e.child_kind,e.child_id FROM ${relation} e
   WHERE e.parent_kind=${node}.kind AND e.parent_id=${node}.id OFFSET 0
  ) e`

function privacyTraversal(relation) {
  const recursive = `UNION SELECT e.child_kind,e.child_id FROM closure c JOIN ${relation} e ON e.parent_kind=c.kind AND e.parent_id=c.id`
  const reached = '), reached AS MATERIALIZED(SELECT * FROM closure LIMIT 4097),'
  return [
    [`${recursive}\n ${reached}`, `UNION SELECT e.child_kind,e.child_id FROM closure c\n  ${adjacent(relation, 'c')}
 ${reached} reached_${relation} AS MATERIALIZED(
  SELECT r.kind parent_kind,r.id parent_id,e.child_kind,e.child_id FROM reached r
  ${adjacent(relation, 'r')}
 ),`],
    [`UNION SELECT e.parent_kind,e.parent_id FROM denied d JOIN ${relation} e ON e.child_kind=d.kind AND e.child_id=d.id
   JOIN reached r ON r.kind=e.parent_kind AND r.id=e.parent_id`,
    `UNION SELECT e.parent_kind,e.parent_id FROM denied d
   JOIN reached_${relation} e ON e.child_kind=d.kind AND e.child_id=d.id`],
  ]
}

export const fusedPrivacyCostReplacements = [...privacyTraversal('edges'), ...privacyTraversal('causal_edges')]

const recordingSignature = 'recording_source_read_allowed(uuid,text,uuid)'
const { manifest } = JSON.parse(await readFile(new URL('conversion-predecessor-source.json', import.meta.url), 'utf8'))
const recordingBody = manifest.contracts.find(entry => entry.signature === recordingSignature)?.bodyParts
const recordingStart = ' WITH RECURSIVE walk(frontier,visited) AS ('
const recordingEnd = ' ), parents AS MATERIALIZED ('
if (recordingBody?.length !== 1 || typeof recordingBody[0] !== 'string'
    || recordingBody[0].split(recordingStart).length !== 2 || recordingBody[0].split(recordingEnd).length !== 2) {
  throw Error('recording_privacy_frontier_source_changed')
}
const recordingFrontier = recordingStart + recordingBody[0].split(recordingStart)[1].split(recordingEnd)[0]
const recordingTraversal = ` WITH RECURSIVE edges(parent_kind,parent_id,child_kind,child_id) AS NOT MATERIALIZED(
  SELECT d.resource_kind,d.resource_id,s.source_kind,s.source_id FROM scope_derivations d
   JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id WHERE d.workspace_id=w
  UNION ALL SELECT 'application_field',o.resource_id,o.source_kind,o.source_id FROM application_field_observations o WHERE o.workspace_id=w
  UNION ALL SELECT 'application_field',o.resource_id,o.source_kind,o.source_id FROM application_field_observation_sources o WHERE o.workspace_id=w
  UNION ALL SELECT 'application_field',f.id,'session_message',f.resource_id FROM application_field_resources f
   WHERE f.workspace_id=w AND f.origin='{"kind":"native","moduleKey":"native"}'::jsonb
    AND f.type_key IN('session_message','session_message_annotation')
 ), nodes(kind,id) AS (
  SELECT k,i
  UNION SELECT e.child_kind,e.child_id FROM nodes n
  ${adjacent('edges', 'n')}
`

const singleCohortRoute = ` IF cohorts IS NULL AND jsonb_typeof(roots)='array' THEN
  IF jsonb_array_length(roots) BETWEEN 1 AND 4096 AND (`
const directMemoryRoute = ` IF cohorts IS NULL THEN
  route_roots:=roots;
 ELSIF roots IS NULL AND authority IS NULL AND jsonb_typeof(cohorts)='array' THEN
  IF jsonb_array_length(cohorts)=2 AND NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(cohorts) grp(roots)
   WHERE CASE WHEN jsonb_typeof(grp.roots)='array' THEN jsonb_array_length(grp.roots) NOT BETWEEN 1 AND 4096 ELSE true END
  ) AND jsonb_path_exists(cohorts,'$[*][*] ? (@.kind == "memory")') THEN
   SELECT jsonb_agg(DISTINCT item.node) INTO route_roots
   FROM jsonb_array_elements(cohorts) grp(roots) CROSS JOIN jsonb_array_elements(grp.roots) item(node);
  END IF;
 END IF;
 IF jsonb_typeof(route_roots)='array' THEN
  IF jsonb_array_length(route_roots) BETWEEN 1 AND 4096 AND (`

export const contextCostReplacements = [
  ['conversation_capture_privacy(uuid,jsonb)', fusedPrivacyCostReplacements],
  // Recursive UNION tracks exact visited keys without rebuilding a JSON worklist.
  [recordingSignature, [[recordingFrontier, recordingTraversal]]],
  ['capture_conversation_evidence(uuid,jsonb,jsonb,jsonb)', [
    ['DECLARE result jsonb;routed boolean:=false;', 'DECLARE result jsonb;routed boolean:=false;route_roots jsonb;'],
    [' -- Directly declared native annotation selectors use the canonical graph.',
      ` -- Directly declared Memory roots and native annotation selectors use the canonical graph.
 -- A direct Memory root makes the fused graph unsupported. Leave query-domain
 -- roots to their separate fused entry check.`],
    [singleCohortRoute, directMemoryRoute],
    ['    FROM jsonb_array_elements(roots) n', '    FROM jsonb_array_elements(route_roots) n'],
    ['   AND EXISTS(\n    SELECT 1 FROM input i JOIN application_field_resources f', `   AND ((EXISTS(SELECT 1 FROM input i WHERE i.kind='memory')
      AND NOT EXISTS(SELECT 1 FROM input i WHERE i.kind='application_query_domain'))
    OR (cohorts IS NULL AND EXISTS(
    SELECT 1 FROM input i JOIN application_field_resources f`],
    ["     AND f.selected_version IS NULL AND f.selection='query')", "     AND f.selected_version IS NULL AND f.selection='query')))"],
  ]],
]
