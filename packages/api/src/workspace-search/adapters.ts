import { WORKSPACE_SEARCH_FAMILIES, type WorkspaceSearchFamily } from '@use-brian/shared'
import { searchDatabase } from './database.js'
import type { SearchAdapter, SearchAdapters, SearchCandidate } from './service.js'
import { OFFICE_SEARCH_REVISION } from './office-projection.js'

// All source reads run on the authenticated app role, in addition to these
// explicit current-department and owner predicates. RLS retains source ACLs.
const department = (alias: string, owner = `${alias}.user_id`) =>
  `department_row_allows((SELECT department_read_grants()), ${alias}.workspace_id, ${alias}.sensitivity, ${alias}.compartments, ${owner})`
const live = (alias: string) => `${alias}.retracted_at IS NULL AND ${alias}.valid_from <= now() AND (${alias}.valid_to IS NULL OR ${alias}.valid_to > now())`
const record = (prefix: string, alias: string, title: string, body: string, updated: string, target: string, status = 'NULL::text') =>
  `SELECT '${prefix}:' || ${alias}.id::text AS key, ${alias}.id::text AS id, coalesce(${title}, '') AS title,
    coalesce(${body}, '') AS body, date_trunc('milliseconds',${updated}) AS updated, ${target} AS target, ${status} AS status`
const brainTarget = (alias: string, primitive: string) => `jsonb_build_object('type','brain','id',${alias}.id,'primitive',${primitive})`
const jsonText = (expression: string) => `(SELECT string_agg(value #>> '{}', ' ') FROM jsonb_path_query(coalesce(${expression}, '{}'::jsonb), 'strict $.**.text') value WHERE jsonb_typeof(value)='string')`

/** Canonical identity is assigned before ranking; chunks never become hits. */
export const SEARCH_SOURCE_SQL: Record<WorkspaceSearchFamily, string> = {
  pages: `${record('page', 'p', 'coalesce(d.snapshot_title,p.name)', jsonText('coalesce(d.snapshot_json,p.page)'), 'p.updated_at', "jsonb_build_object('type','page','id',p.id)")}
    FROM saved_views p LEFT JOIN documents d ON d.page_id=p.id
    WHERE p.workspace_id=$1 AND (p.state='saved' OR (p.state='draft' AND p.created_by=$2))
      AND saved_view_principal_boundary_allows(p.workspace_id,p.created_by,p.teamspace_id,p.clearance,p.project_id)
      AND saved_view_operation_scope_allows(p.workspace_id,p.clearance,p.teamspace_id,p.project_id,false)
      AND department_row_allows((SELECT department_read_grants()),p.workspace_id,
        coalesce((SELECT CASE WHEN sensitivity_rank(t.sensitivity)>sensitivity_rank(p.clearance) THEN t.sensitivity ELSE p.clearance END
          FROM teamspaces t WHERE t.id=p.teamspace_id AND t.workspace_id=p.workspace_id),p.clearance),
        ARRAY(SELECT g.compartment_key FROM teamspaces t JOIN workspace_groups g ON g.id=t.workspace_group_id
          WHERE t.id=p.teamspace_id AND t.workspace_id=p.workspace_id AND g.compartment_key IS NOT NULL),NULL::uuid)`,
  knowledge: `${record('knowledge', 'k', 'k.title', `concat_ws(' ',k.summary,k.content,
      (SELECT string_agg(c.chunk_text,' ' ORDER BY c.chunk_index) FROM kb_chunks c
        WHERE c.workspace_id=k.workspace_id AND c.source_path=k.path AND ${live('c')} AND ${department('c')}))`,
    'k.updated_at', "jsonb_build_object('type','knowledge','id',k.id,'path',k.path)")}
    FROM knowledge_entries k WHERE k.workspace_id=$1 AND ${department('k', 'NULL::uuid')}
    UNION ALL
    ${record('memory', 'm', 'm.summary', "concat_ws(' ',m.summary,m.detail)", 'm.updated_at', brainTarget('m', "'memories'"))}
    FROM memories m WHERE m.workspace_id=$1 AND ${live('m')} AND ${department('m')}`,
  records: `${record('entity', 'e', 'e.display_name', `concat_ws(' ',e.display_name,e.attributes->>'description',e.attributes->>'notes',
      e.attributes->>'email',e.attributes->>'phone',e.attributes->>'domain',e.attributes->>'stage')`,
    'e.updated_at', brainTarget('e', "CASE e.kind WHEN 'person' THEN 'people' WHEN 'company' THEN 'companies' WHEN 'deal' THEN 'deals' ELSE 'entities' END"))}
    FROM entities e WHERE e.workspace_id=$1 AND ${live('e')} AND ${department('e')}
    UNION ALL
    ${record('record', 'r', "r.data -> (t.properties->0->>'name') ->> 'value'", `(SELECT string_agg(cell.value->>'value',' ' ORDER BY cell.key)
      FROM jsonb_each(r.data) cell WHERE cell.value->>'kind' IN ('text','title','rich_text','email','url','phone')
      AND cell.key !~* '(password|secret|credential|token|cookie)')`, 'r.last_edited_at',
    "jsonb_build_object('type','record','id',r.id,'entityTypeId',r.entity_type_id)")}
    FROM entity_instances r JOIN entity_types t ON t.id=r.entity_type_id AND t.workspace_id=r.workspace_id
    WHERE r.workspace_id=$1 AND ${department('r')}`,
  tasks: `${record('task', 't', 't.title', "concat_ws(' ',t.title,t.attributes->>'description')", 't.updated_at', brainTarget('t', "'tasks'"), 't.status')}
    FROM tasks t WHERE t.workspace_id=$1 AND ${live('t')} AND ${department('t')}`,
  files: `${record('file', 'f', 'coalesce(f.title,f.name)', `concat_ws(' ',f.summary,
      (SELECT string_agg(s.content,' ' ORDER BY s.segment_index) FROM file_segments s
        WHERE s.workspace_id=f.workspace_id AND s.file_id=f.id AND ${live('s')} AND ${department('s')}))`,
    'f.updated_at', brainTarget('f', "'files'"))}
    FROM workspace_files f WHERE f.workspace_id=$1 AND ${live('f')} AND ${department('f')}
    UNION ALL
    ${record('recording', 'r', 'coalesce(r.title,r.file_name)', `(SELECT string_agg(s.segment_text,' ' ORDER BY s.segment_index)
      FROM transcript_segments s WHERE s.recording_id=r.id AND s.workspace_id=r.workspace_id AND ${live('s')} AND ${department('s')})`,
    'r.updated_at', "jsonb_build_object('type','recording','id',r.id)")}
    FROM recordings r WHERE r.workspace_id=$1 AND r.retracted_at IS NULL AND (r.valid_to IS NULL OR r.valid_to>now()) AND ${department('r')}`,
  office: `${record('office', 'a', 'a.title', 'p.body', 'a.updated_at', "jsonb_build_object('type','office','id',a.id,'family',a.family)",
    `CASE WHEN p.revision=(${OFFICE_SEARCH_REVISION}) THEN NULL ELSE 'index_pending' END`)}
    FROM office_artifacts a LEFT JOIN workspace_search_office_text p ON p.artifact_id=a.id
    LEFT JOIN office_collab_documents d ON d.artifact_id=a.id
    WHERE a.workspace_id=$1 AND a.lifecycle_state IN ('active','archived') AND a.mode='artifact'
      AND a.family IN ('document','presentation','spreadsheet') AND ${department('a', 'NULL::uuid')}
      AND workspace_search_office_allows(a.id,a.workspace_id)
      AND office_root_scope_allows(a.id,a.workspace_id,a.sensitivity,a.compartments,a.project_ids,a.visibility_user_ids,a.visibility_assistant_ids,false)
      AND (a.creator_user_id=$2 OR a.owner_user_id=$2 OR a.default_workspace_role<>'deny'
        OR EXISTS(SELECT 1 FROM office_artifact_grants g WHERE g.artifact_id=a.id AND g.user_id=$2 AND g.revoked_at IS NULL AND g.role<>'deny'))`,
  conversations: `${record('conversation', 's', 's.title', `(SELECT string_agg(
      CASE WHEN jsonb_typeof(m.content)='string' THEN m.content#>>'{}'
        WHEN jsonb_typeof(m.content)='array' THEN (SELECT string_agg(block->>'text',' ') FROM jsonb_array_elements(m.content) block WHERE block->>'type'='text')
        ELSE '' END, ' ' ORDER BY m.sequence_num)
      FROM session_messages m WHERE m.session_id=s.id AND m.role IN ('user','assistant')
        AND m.scope_held IS NOT TRUE AND ${department('m')}
        AND NOT jsonb_path_exists(m.content,'$[*] ? (@.type == "tool_use" || @.type == "tool_result")'))`,
    's.last_active_at', "jsonb_build_object('type','conversation','id',s.id,'visibility',coalesce(s.visibility,'owner'))")}
    FROM sessions s WHERE s.workspace_id=$1 AND public.assistant_placement_visible($2,s.assistant_id) AND s.channel_type='web' AND s.transient IS NOT TRUE
      AND s.mode IS DISTINCT FROM 'draft' AND (s.user_id=$2 OR s.visibility='workspace')
      AND department_row_allows((SELECT department_read_grants()),s.workspace_id,coalesce(s.effective_clearance,'internal'),s.context_compartments,
        CASE WHEN s.visibility='workspace' THEN NULL ELSE s.user_id END)`,
  workflows: `${record('workflow', 'w', 'w.name', 'w.description', 'w.updated_at', "jsonb_build_object('type','workflow','id',w.id)")}
    FROM workflows w WHERE w.workspace_id=$1 AND w.lifecycle_state NOT IN ('deleted','trash')
      AND department_row_allows((SELECT department_read_grants()),w.workspace_id,'internal',
        ARRAY(SELECT g.compartment_key FROM workspace_groups g WHERE g.id=w.context_group_id AND g.workspace_id=w.workspace_id AND g.compartment_key IS NOT NULL),NULL::uuid)`,
}

const normalized = (expression: string) => `lower(regexp_replace(normalize(coalesce(${expression},''),NFKC),'[[:space:]]+',' ','g'))`

export function createSearchAdapters(): SearchAdapters {
  return Object.fromEntries(WORKSPACE_SEARCH_FAMILIES.map(kind => [kind, async (input: Parameters<SearchAdapter>[0]) => {
    const sql = `WITH authorized AS MATERIALIZED (
        ${SEARCH_SOURCE_SQL[kind]}
      ), normalized AS (
        SELECT *,btrim(${normalized('title')}) AS name,btrim(${normalized('body')}) AS text FROM authorized
        WHERE EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2)
      ), matched AS (
        SELECT *,CASE WHEN name=$3 THEN 0 WHEN starts_with(name,$3) THEN 1
          WHEN NOT EXISTS(SELECT 1 FROM unnest($4::text[]) token WHERE strpos(name,token)=0) THEN 2
          WHEN EXISTS(SELECT 1 FROM unnest($4::text[]) token WHERE strpos(name,token)>0) THEN 3 ELSE 4 END AS match_order,
          (SELECT count(*)::int FROM unnest($4::text[]) token WHERE strpos(name,token)>0 OR strpos(text,token)>0) AS relevance
        FROM normalized WHERE status IS DISTINCT FROM 'index_pending' AND
          (EXISTS(SELECT 1 FROM unnest($4::text[]) token WHERE strpos(name,token)>0)
          OR NOT EXISTS(SELECT 1 FROM unnest($4::text[]) token WHERE strpos(text,token)=0))
      ), page AS (SELECT key,id,title,substring(body FROM greatest(1,strpos(text,($4::text[])[1])-60) FOR 240) AS snippet,
        updated AS "updatedAt",target,status,relevance,match_order
      FROM matched ORDER BY match_order,relevance DESC,updated DESC NULLS LAST,key COLLATE "C" LIMIT $5 OFFSET $6)
      SELECT coalesce(jsonb_agg(page ORDER BY match_order,relevance DESC,"updatedAt" DESC NULLS LAST,key COLLATE "C"),'[]') AS items,
        EXISTS(SELECT 1 FROM authorized WHERE status='index_pending') AS pending FROM page`
    const result = await searchDatabase<{ items: Array<SearchCandidate & { match_order: number }>; pending: boolean }>(input, input.signal, sql,
      [input.workspaceId,input.userId,input.query,input.query.split(' '),input.limit,input.offset])
    if (result[0]?.pending) throw new Error('Office search projection pending')
    const rows = result[0]?.items ?? []
    return rows.map(({ match_order, ...row }) => ({ ...row, kind, source: kind,
      match: (['exact','prefix','tokens','partial','body'] as const)[match_order]!,
      updatedAt: row.updatedAt ? new Date(row.updatedAt as string).toISOString() : undefined,
    }))
  }])) as SearchAdapters
}

/** Identity read for revocation-safe preview/open; no unbounded query or client ACL. */
export async function readSearchItem(scope: {userId:string;workspaceId:string}, kind:WorkspaceSearchFamily, key:string, signal:AbortSignal) {
  const rows=await searchDatabase<{key:string;id:string;title:string;body:string;target:SearchCandidate['target'];status:string|null}>(scope,signal,
    `WITH authorized AS MATERIALIZED (${SEARCH_SOURCE_SQL[kind]})
     SELECT key,id,title,left(body,4000) AS body,target,status FROM authorized WHERE key=$3
       AND status IS DISTINCT FROM 'index_pending'
       AND EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2) LIMIT 1`,[scope.workspaceId,scope.userId,key])
  const row=rows[0]
  return row ? {key:row.key,id:row.id,title:row.title,text:row.body,target:row.target,kind,status:row.status} : null
}
