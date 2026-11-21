// [COMP:api/application-persistence] Expand each Memory predecessor once per exact lineage node.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { executableProjection } from './executable-record.mjs'

const memoryAncestorSignature = 'scope_source_ancestors_before_browser_profile(uuid,text,uuid)'
const ancestorRoot = 'SELECT id FROM memories WHERE workspace_id=p_workspace AND id=p_id'
// The globally unique ID selects the anchor even before ANALYZE. Keep the
// workspace equality as a residual filter with the original WHERE null behavior.
const indexedAncestorRoot = 'SELECT id FROM memories WHERE id=p_id AND coalesce(workspace_id=p_workspace,false)'
const ancestorStep = 'UNION SELECT r.id FROM memories r JOIN ancestry a ON r.superseded_by=a.id WHERE r.workspace_id=p_workspace'
const indexedAncestorStep = `UNION SELECT prior.id FROM ancestry a CROSS JOIN LATERAL (
       SELECT r.id FROM memories r WHERE r.workspace_id=p_workspace AND r.superseded_by=a.id
        AND r.superseded_by IS NOT NULL OFFSET 0
      ) prior`
const memoryAncestorReplacements = [[ancestorRoot, indexedAncestorRoot], [ancestorStep, indexedAncestorStep]]

const memoryEdgeRoutines = [
  'application_scope_source_edges(uuid,text,uuid,text)',
  'knowledge_version_source_edges(uuid,text,uuid,text)',
  'application_scope_source_edges_before_knowledge_versions(uuid,text,uuid,text)',
  'application_native_source_edges_dispatch(uuid,text,uuid,text)',
  'scope_source_table(text)',
  'scope_source_table_before_knowledge_versions(text)',
  'scope_source_table_before_persistent_context(text)',
  'scope_source_table_before_media(text)',
  'scope_source_ancestors(uuid,text,uuid)',
  'scope_source_ancestors_before_workflow_run(uuid,text,uuid)',
  'scope_source_ancestors_before_browser_session(uuid,text,uuid)',
  memoryAncestorSignature,
]

// A later release can legitimately repin the installed helper registry. The
// compiled Memory branch still depends on the fixed, reviewed wrapper bodies
// and their original execution context.
const { manifest } = JSON.parse(await readFile(new URL('conversion-predecessor-source.json', import.meta.url), 'utf8'))
const quote = value => "'" + value.replaceAll("'", "''") + "'"
const memoryContracts = memoryEdgeRoutines.map(name => {
  const contract = manifest.contracts.find(entry => entry.signature === name)
  if (contract?.bodyParts.length !== 1 || typeof contract.bodyParts[0] !== 'string')
    throw Error('conversation_memory_edge_contract_source_changed: ' + name)
  const { proconfig, prolang, prosecdef, provolatile } = contract.metadata
  let body = contract.bodyParts[0]
  if (name === memoryAncestorSignature) {
    for (const [before, after] of memoryAncestorReplacements) {
      if (body.split(before).length !== 2) throw Error('conversation_memory_ancestor_source_changed')
      body = body.replace(before, after)
    }
  }
  const hash = createHash('sha256').update(body).digest('hex')
  const config = proconfig ? `ARRAY[${proconfig.map(quote).join(',')}]::text[]` : 'NULL::text[]'
  return `(${quote(name)},${quote(hash)},${config},${quote(prolang.$slot.identity)},${prosecdef},${quote(provolatile)})`
}).join(',\n   ')

const walk = ` WITH RECURSIVE lineage(kind,id,version) AS (
  SELECT * FROM unnest(kinds,ids,versions)
  UNION
  SELECT next.kind,next.id,next.version FROM lineage l
   CROSS JOIN LATERAL application_scope_source_edges(w,l.kind,l.id,l.version) next
 ), bounded AS MATERIALIZED(SELECT * FROM lineage LIMIT 4097)
 SELECT coalesce(jsonb_agg(to_jsonb(b)),'[]') INTO nodes FROM bounded b;`

const memoryWalk = ` -- R2 closure still uses one UNION for all exact nodes. A Memory predecessor
 -- keeps the incoming version, while recorded derivations keep their own
 -- source versions and apply to every version of the current resource ID.
 WITH RECURSIVE memory_edges AS MATERIALIZED (
  SELECT coalesce(bool_and(h.signature IS NOT NULL AND p.oid IS NOT NULL
   AND h.contract IS NOT DISTINCT FROM ${executableProjection('p')}
   AND p.proowner=current_user::regrole AND p.prosecdef=expected.secdef AND p.provolatile::text=expected.volatility
   AND p.prolang=language.oid AND p.proconfig IS NOT DISTINCT FROM expected.config
   AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=expected.body_hash),false) AS enabled
  FROM (VALUES ${memoryContracts}) expected(signature,body_hash,config,language,secdef,volatility)
  LEFT JOIN public.native_turn_contract_helpers h ON h.signature=expected.signature
  LEFT JOIN pg_catalog.pg_proc p ON p.oid=to_regprocedure('public.'||expected.signature)
  LEFT JOIN pg_catalog.pg_language language ON language.lanname=expected.language
 ), lineage(kind,id,version) AS (
  SELECT * FROM unnest(kinds,ids,versions)
  UNION
  SELECT next.kind,next.id,next.version FROM lineage l
  CROSS JOIN LATERAL (
   SELECT s.source_kind AS kind,s.source_id AS id,s.source_version AS version FROM public.scope_derivations d
   JOIN public.scope_derivation_sources s ON s.workspace_id=w AND s.derivation_id=d.id
   WHERE (SELECT enabled FROM memory_edges) AND l.kind='memory'
    AND d.workspace_id=w AND d.resource_kind=l.kind AND d.resource_id=l.id
   UNION ALL
   SELECT l.kind,prior.id,l.version FROM public.memories prior
   WHERE (SELECT enabled FROM memory_edges) AND l.kind='memory' AND prior.workspace_id=w AND prior.superseded_by=l.id
    AND EXISTS(SELECT 1 FROM public.memories live WHERE live.id=l.id AND coalesce(live.workspace_id=w,false))
   UNION ALL
   SELECT e.kind,e.id,e.version FROM (
    SELECT l.kind,l.id,l.version WHERE l.kind IS DISTINCT FROM 'memory' OR NOT (SELECT enabled FROM memory_edges) OFFSET 0
   ) original CROSS JOIN LATERAL application_scope_source_edges(w,original.kind,original.id,original.version) e
  ) next
 ), bounded AS MATERIALIZED(SELECT * FROM lineage LIMIT 4097)
 SELECT coalesce(jsonb_agg(to_jsonb(b)),'[]'),
  CASE WHEN (SELECT enabled FROM memory_edges) THEN pg_current_snapshot()::text END
 INTO nodes,memory_stamp FROM bounded b;
 -- Extension calls remain volatile. Revert to the original walk if a fresh
 -- SPI snapshot differs from the one that supplied the compiled Memory edges.
 IF memory_stamp IS NOT NULL THEN
  SELECT pg_current_snapshot()::text INTO current_stamp FROM pg_catalog.pg_namespace WHERE nspname='pg_catalog';
  IF memory_stamp IS DISTINCT FROM current_stamp THEN
${walk}
  END IF;
 END IF;`

export const lineageCostReplacements = [
  [memoryAncestorSignature, memoryAncestorReplacements],
  ['application_scope_lineage(uuid,text[],uuid[],text[])', [
    ['DECLARE nodes jsonb;', 'DECLARE nodes jsonb;memory_stamp text;current_stamp text;'],
    [walk, memoryWalk],
  ]],
]
