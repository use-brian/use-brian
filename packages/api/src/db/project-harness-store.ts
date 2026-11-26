/** Actor-bound persistence for shared-Project engineering contracts. */
import type { AccessContext } from '@use-brian/agent-runtime/security/access-context.js'
import { boundScopeSources } from '@use-brian/agent-runtime/security/source-evidence.js'
import type { ScopeEvidence } from '@use-brian/agent-runtime/security/context-scope.js'
import { readLegacyCanonicalTask } from './task-reader.js'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { applyRLSGucs, getAppPool, rollbackAndRelease } from './client.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'
import {
  createEngineeringNodeSchema, updateEngineeringNodeSchema, harnessScopeSchema,
  harnessDefinitionSchema, putHarnessDefinitionSchema,
  type ProjectHarnessStore, type ProjectProduct, type ProductComponent, type HarnessRevision, type HarnessScope, type HarnessProjectSnapshot,
} from '../project-harness/contracts.js'

const errors: Record<string, number> = {
  harness_actor_required: 401, harness_not_found: 404, harness_requires_shared_project: 409,
  harness_owner_required: 403, harness_archived: 409, harness_revision_stale: 409,
  harness_invalid_input: 400, harness_parent_immutable: 409, harness_history_immutable: 409,
}
const uuid = z.string().uuid()
function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new WorkspaceAccessError('harness_invalid_input', 400)
  return result.data
}
async function asActor<T>(actor: string, workspaceId: string, projectId: string, write: boolean,
  work: (client: PoolClient) => Promise<T>): Promise<T> {
  parse(uuid, actor); parse(uuid, workspaceId); parse(uuid, projectId)
  const client = await getAppPool().connect()
  try {
    // A lineage includes authorization, empty-target validation and every head
    // in the same snapshot. Mutations instead recheck after ordered row locks.
    await client.query(write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await applyRLSGucs(client, actor)
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    if (error instanceof WorkspaceAccessError) throw error
    const { message, code } = error as { message?: string; code?: string }
    if (message && Object.hasOwn(errors, message)) throw new WorkspaceAccessError(message, errors[message])
    if (code && ['40001', '40P01', '23505'].includes(code)) throw new WorkspaceAccessError('harness_revision_stale', 409)
    // Do not propagate database DETAIL (which may contain the full document).
    if (code && ['23514', '23503', '22P02', '22003', '22001', '23502'].includes(code)) {
      throw new WorkspaceAccessError('harness_invalid_input', 400)
    }
    throw new WorkspaceAccessError('harness_unavailable', 503)
  } finally {
    await rollbackAndRelease(client)
  }
}
type NodeRow = {
  id: string; workspace_id: string; project_id: string; product_id?: string;
  name: string; description: string | null; status: 'active' | 'archived'; revision: number | string;
  created_at: string; updated_at: string;
}
type RevisionRow = {
  id: string; workspace_id: string; project_id: string; product_id: string | null; component_id: string | null;
  revision: number | string; definition: unknown; created_by: string | null; created_at: string;
}
function node(row: NodeRow): ProjectProduct {
  return { id: row.id, workspaceId: row.workspace_id, projectId: row.project_id, name: row.name,
    description: row.description, status: row.status, revision: Number(row.revision),
    createdAt: row.created_at, updatedAt: row.updated_at }
}
function component(row: NodeRow): ProductComponent { return { ...node(row), productId: row.product_id! } }
function revision(row: RevisionRow): HarnessRevision {
  return { id: row.id, workspaceId: row.workspace_id, projectId: row.project_id,
    scope: row.component_id ? { kind: 'component', productId: row.product_id!, componentId: row.component_id }
      : row.product_id ? { kind: 'product', productId: row.product_id } : { kind: 'project' },
    revision: Number(row.revision), definition: parse(harnessDefinitionSchema, row.definition),
    createdBy: row.created_by, createdAt: row.created_at }
}
function ancestry(input: HarnessScope): [string | null, string | null] {
  const scope = parse(harnessScopeSchema, input)
  return [scope.kind === 'project' ? null : scope.productId, scope.kind === 'component' ? scope.componentId : null]
}

/** Complete authorized tree and current heads from one repeatable-read snapshot.
 * Separate helper preserves compatibility with existing ProjectHarnessStore mocks.
 * References remain metadata; this does not fetch repository/source contents.
 */
export async function readHarnessProjectSnapshot(userId: string, workspaceId: string, projectId: string,
  handoff?: { brianTaskId: string; access: AccessContext }): Promise<HarnessProjectSnapshot & { taskEvidence?: ScopeEvidence }> {
  return asActor(userId, workspaceId, projectId, false, async client => {
    const tree = (await client.query<{ result: { products: NodeRow[]; components: NodeRow[] } }>(
      "SELECT public.project_harness_read($1,$2,NULL,NULL,'tree') AS result", [workspaceId, projectId])).rows[0].result
    let taskEvidence: ScopeEvidence | undefined
    if (handoff) {
      const { access, brianTaskId } = handoff
      if (access.systemRead || access.userId !== userId || access.workspaceId !== workspaceId) {
        throw new WorkspaceAccessError('harness_not_found', 404)
      }
      // Use canonical Task/source admission, not mere workspace membership. Do
      // not substitute a successor, infer an ID, or include Task content in the plan.
      const task = await readLegacyCanonicalTask(access, parse(uuid, brianTaskId), client)
      if (!task || task.id !== brianTaskId.toLowerCase() || task.workspaceId !== workspaceId ||
        !(task.projectIds?.includes(projectId) || (task.home?.kind === 'project' && task.home.id === projectId))) {
        throw new WorkspaceAccessError('harness_not_found', 404)
      }
      const sources = boundScopeSources(task)
      if (!sources.some(s => s.resourceKind === 'task' && s.resourceId === task.id && s.workspaceId === workspaceId)) {
        throw new WorkspaceAccessError('harness_unavailable', 503)
      }
      taskEvidence = { sources: [...sources] }
    }
    const heads = await client.query<{ result: RevisionRow }>(
      `SELECT to_jsonb(head) AS result FROM (
        SELECT DISTINCT ON (scope_id) * FROM public.project_harness_revisions
        WHERE workspace_id=$1 AND project_id=$2 ORDER BY scope_id,revision DESC
      ) head ORDER BY scope_id`, [workspaceId, projectId])
    return { ...(taskEvidence ? { taskEvidence } : {}), tree: { products: tree.products.map(node), components: tree.components.map(component) }, revisions: heads.rows.map(row => revision(row.result)) }
  })
}

export function createProjectHarnessStore(): ProjectHarnessStore {
  const read = async (actor: string, w: string, p: string, scope: HarnessScope, mode: string) => {
    const [product, child] = ancestry(scope)
    return asActor(actor, w, p, false, async client => {
      const { rows } = await client.query<{ result: RevisionRow[] }>(
        'SELECT public.project_harness_read($1,$2,$3,$4,$5) AS result', [w, p, product, child, mode])
      return rows[0].result.map(revision)
    })
  }
  const writeNode = (actor: string, w: string, p: string, product: string | null, id: string | null, input: unknown) => {
    if (product !== null) parse(uuid, product)
    if (id !== null) parse(uuid, id)
    const parsed = id === null ? parse(createEngineeringNodeSchema, input) : parse(updateEngineeringNodeSchema, input)
    const { expectedRevision = 0, ...patch } = parsed as typeof parsed & { expectedRevision?: number }
    return asActor(actor, w, p, true, async client => (await client.query<{ result: NodeRow }>(
      'SELECT public.project_harness_write_node($1,$2,$3,$4,$5::jsonb,$6) AS result',
      [w, p, product, id, JSON.stringify(patch), expectedRevision])).rows[0].result)
  }
  return {
    async tree(actor, w, p) {
      return asActor(actor, w, p, false, async client => {
        const { rows } = await client.query<{ result: { products: NodeRow[]; components: NodeRow[] } }>(
          "SELECT public.project_harness_read($1,$2,NULL,NULL,'tree') AS result", [w, p])
        return { products: rows[0].result.products.map(node), components: rows[0].result.components.map(component) }
      })
    },
    async createProduct(actor, w, p, input) { return node(await writeNode(actor, w, p, null, null, input)) },
    async updateProduct(actor, w, p, id, input) { return node(await writeNode(actor, w, p, null, id, input)) },
    async createComponent(actor, w, p, product, input) { return component(await writeNode(actor, w, p, product, null, input)) },
    async updateComponent(actor, w, p, product, id, input) { return component(await writeNode(actor, w, p, product, id, input)) },
    async definition(actor, w, p, scope) { return (await read(actor, w, p, scope, 'definition'))[0] ?? null },
    history(actor, w, p, scope) { return read(actor, w, p, scope, 'history') },
    lineage(actor, w, p, scope) { return read(actor, w, p, scope, 'lineage') },
    async putDefinition(actor, w, p, input) {
      const parsed = parse(putHarnessDefinitionSchema, input)
      const [product, child] = ancestry(parsed.scope)
      return asActor(actor, w, p, true, async client => revision((await client.query<{ result: RevisionRow }>(
        'SELECT public.project_harness_put($1,$2,$3,$4,$5,$6::jsonb) AS result',
        [w, p, product, child, parsed.expectedRevision, JSON.stringify(parsed.definition)])).rows[0].result))
    },
  }
}
