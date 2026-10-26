/** Project counts and records under canonical current-member policy. [COMP:api/project-aggregates] */
import { queryWithRLS } from './client.js'
import { PROJECT_COUNT_SOURCE_SQL, PROJECT_SEARCH_SOURCE_SQL } from '../workspace-search/adapters.js'
import type { WorkspaceSearchFamily, WorkspaceSearchTarget } from '@use-brian/shared'

// Reuse each resource's canonical authorized projection instead of applying a
// brain-row predicate to tables with different visibility columns. Counts omit
// payload projection entirely; source predicates apply Project scope directly.
const SOURCES: Array<{ label: string; family: WorkspaceSearchFamily; prefix: string }> = [
  { label: 'memories', family: 'knowledge', prefix: 'memory' },
  { label: 'tasks', family: 'tasks', prefix: 'task' },
  { label: 'files', family: 'files', prefix: 'file' },
  { label: 'entities', family: 'records', prefix: 'entity' },
  { label: 'knowledge', family: 'knowledge', prefix: 'knowledge' },
  { label: 'recordings', family: 'files', prefix: 'recording' },
  { label: 'office', family: 'office', prefix: 'office' },
  { label: 'pages', family: 'pages', prefix: 'page' },
  { label: 'workflows', family: 'workflows', prefix: 'workflow' },
]

const COUNTS_SQL = [
  ...SOURCES.map(source => `SELECT '${source.label}' AS label, count(*)::text AS count
    FROM (${PROJECT_COUNT_SOURCE_SQL[source.family]}) visible
    WHERE visible.source = '${source.prefix}'`),
  `SELECT 'episodes' AS label, count(*)::text AS count FROM episodes e
    WHERE e.workspace_id=$1 AND $3::uuid = ANY(e.project_ids)
      AND NOT e.scope_held
      AND department_row_allows((SELECT department_read_grants()),e.workspace_id,e.sensitivity,e.compartments,e.user_id)`,
  `SELECT 'goals' AS label, count(*)::text AS count FROM goals g
    WHERE g.workspace_id=$1 AND g.context_project_id=$3::uuid
      AND department_row_allows((SELECT department_read_grants()),g.workspace_id,'internal',
        ARRAY(SELECT d.compartment_key FROM workspace_groups d WHERE d.id=g.context_group_id
          AND d.workspace_id=g.workspace_id AND d.compartment_key IS NOT NULL),NULL::uuid)`,
].join(' UNION ALL ')

export async function projectAggregates(userId: string, workspaceId: string, projectId: string): Promise<Record<string, number>> {
  const result = await queryWithRLS<{ label: string; count: string }>(userId, COUNTS_SQL, [workspaceId, userId, projectId])
  return Object.fromEntries(result.rows.map(row => [row.label, Number(row.count)]))
}


export type ProjectContentView = 'work' | 'knowledge' | 'recent'
const CONTENT_SOURCES = [...SOURCES,
  { label: 'conversations', family: 'conversations' as const, prefix: 'conversation' },
]

/** Canonical source policy is evaluated before text filtering and pagination. */
export async function projectContent(userId: string, workspaceId: string, projectId: string,
  view: ProjectContentView, query: string, offset: number) {
  const sources = CONTENT_SOURCES.filter(source => view === 'recent' ||
    (view === 'work' ? ['tasks','pages','office','files','workflows'] : ['memories','knowledge','recordings','entities']).includes(source.label))
  const sql = sources.map(source => `SELECT visible.*, '${source.label}' AS kind
    FROM (${PROJECT_SEARCH_SOURCE_SQL[source.family]}) visible
    WHERE visible.key LIKE '${source.prefix}:%'`).join(' UNION ALL ')
  const result = await queryWithRLS<{
    key: string; id: string; title: string; snippet: string; kind: string;
    target: WorkspaceSearchTarget; status: string | null; updatedAt: string | null;
  }>(userId, `WITH authorized AS MATERIALIZED (${sql})
    SELECT key,id,title,left(body,240) AS snippet,kind,target,status,updated AS "updatedAt"
    FROM authorized
    WHERE ($4='' OR strpos(lower(title),lower($4))>0 OR
      (status IS DISTINCT FROM 'index_pending' AND strpos(lower(body),lower($4))>0))
      AND EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2)
    ORDER BY ${view === 'work' ? "CASE WHEN kind='tasks' AND status NOT IN ('done','archived') THEN 0 ELSE 1 END," : ''}
      updated DESC NULLS LAST,key COLLATE "C" LIMIT 31 OFFSET $5`,
    [workspaceId,userId,projectId,query,offset])
  return { items: result.rows.slice(0,30).map(row => ({...row, snippet: row.status === 'index_pending' ? '' : row.snippet})),
    nextOffset: result.rows.length>30 ? offset+30 : null }
}
