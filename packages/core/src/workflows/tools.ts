/**
 * Workflow brain-write tools (WU-6.11).
 *
 * Three first-party `tool_call` tools the `finalizeProduct` workflow
 * (and any future brain-write workflow) resolves against the per-run
 * tool registry: `createEntity`, `createEdge`, `supersedeMemory`.
 *
 * Pure `packages/core` — DB access is via the injected `EntityStore` /
 * `EntityLinksStore` interfaces plus a narrow `WorkflowMemorySupersedePort`.
 * `apps/api` wires the DB adapters and adds the returned tools to the
 * boot-time first-party map (`allTools`), which `buildWorkflowToolRegistry`
 * snapshots per run.
 *
 * The fourth `finalizeProduct` tool — `githubWriteFile` — is a GitHub
 * connector tool (`packages/core/src/tools/base/github.ts`); it reaches
 * the registry through `injectMcpTools`, not this module.
 *
 * Workflow `tool_call` passes a `ToolContext` carrying `workspaceId`,
 * `userId` (the run's `triggeredBy ?? workflow.createdBy`), and
 * `assistantId` (the workspace primary). These tools attribute every
 * write to that actor.
 *
 * [COMP:workflows/brain-tools]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import type {
  EntityKind,
  EntityLinksStore,
  EntityStore,
} from '../entities/types.js'
import { EDGE_TYPES, LINK_KINDS } from '../entities/types.js'
import { applyExplicitLinks, explicitLinksField, formatLinksSummary } from '../entities/explicit-links.js'

/**
 * `attributes` JSONB fields routinely arrive as JSON strings rather
 * than objects. Gemini in particular serializes nested objects when
 * the parent function signature has a flat string field next to it,
 * and the model copies the shape across calls. The schema accepts
 * either form — if a string, parse it; if it doesn't parse, fail with
 * a directive message.
 */
const attributesShape = z
  .preprocess((v) => {
    if (typeof v !== 'string') return v
    if (v.trim() === '') return {}
    try { return JSON.parse(v) } catch { return v }
  }, z.record(z.unknown()).optional())
  .describe('Free-form attribute bag. Must be an object literal {"key": "value"} — not a JSON-encoded string. If you accidentally serialize, the schema will parse it for you, but pass the object directly when possible.')

/**
 * Synonym remapper for source_kind / target_kind. The model commonly
 * passes domain-natural names ("contact", "company", "deal", "person")
 * which aren't valid `LINK_KINDS` — those all map to `'entity'` since
 * CRM rows are backed by the entities table. Strict mapping; anything
 * outside the synonyms + LINK_KINDS falls through to the enum check.
 */
const KIND_SYNONYMS: Record<string, typeof LINK_KINDS[number]> = {
  contact: 'entity',
  company: 'entity',
  deal: 'entity',
  person: 'entity',
  product: 'entity',
  project: 'entity',
  organization: 'entity',
}
const linkKindShape = z
  .preprocess((v) => {
    if (typeof v !== 'string') return v
    const lower = v.toLowerCase()
    return KIND_SYNONYMS[lower] ?? lower
  }, z.enum(LINK_KINDS))

/**
 * Narrow port for the bulk memory supersession `supersedeMemory` needs.
 * Deliberately separate from the broad `MemoryStore` interface — this is
 * a single workspace-scoped bulk operation, not worth widening the
 * memory contract every `MemoryStore` implementation must satisfy.
 */
export type WorkflowMemorySupersedePort = {
  /**
   * Supersede (`valid_to = now`) every active memory in the workspace
   * whose `tags` array overlaps any of `tags`. Returns the row count.
   */
  supersedeByTags(params: {
    workspaceId: string
    tags: string[]
    now: Date
  }): Promise<number>
}

export type WorkflowBrainToolsDeps = {
  entities: EntityStore
  entityLinks: EntityLinksStore
  memories: WorkflowMemorySupersedePort
  /**
   * Entity-kind classifier. When provided, `createEntity` runs the
   * classifier against the input before writing. Deterministic
   * mismatch returns a typed rejection (Decision 2) so the LLM can
   * re-call the right CRM tool.
   *
   * See docs/architecture/brain/classification/README.md
   *   §Decision semantics per boundary — B2 chat tool
   */
  entityKindClassifier?: import('../classification/types.js').Classifier<EntityKind>
}

/** Guard — workflow runs always carry a workspace; the type allows null. */
function requireWorkspace(workspaceId: string | null | undefined): string {
  if (!workspaceId) {
    throw new Error('workflow brain tool invoked without a workspace context')
  }
  return workspaceId
}

export function createWorkflowBrainTools(deps: WorkflowBrainToolsDeps): Tool[] {
  const createEntityTool = buildTool({
    name: 'createEntity',
    description:
      'Create a non-CRM knowledge-graph entity (product, project, or any free-form kind). ' +
      '⚠️ **HARD REJECT for CRM kinds**: do NOT pass kind="person", "company", or "deal" — those are rejected with an error. ' +
      'For PERSON entities call `saveContact` instead. For COMPANY entities call `saveCompany`. For DEAL entities call `saveDeal`. ' +
      'Those CRM tools materialize the underlying entity row AND a CRM specialization row in one transaction, and they expose the resulting `entityId` you need for `links`. ' +
      'Pass `links` to record outgoing relationships in the same call (e.g. saving MeshJS as kind="product" with links: [{ targetEntityId: <SIDAN entity id>, edgeType: "depends_on" }]). ' +
      'Never call `createEdge` separately to wire up these relationships — `links` on this very call writes the same edges and avoids the orphan-edge failure mode.',
    inputSchema: z
      .object({
        kind: z
          .string()
          .min(1)
          .describe(
            'Entity kind, e.g. "product" or "project". Must NOT be "person", "company", or "deal" — those route through saveContact / saveCompany / saveDeal.',
          )
          .refine((k) => k !== 'person' && k !== 'company' && k !== 'deal', {
            // Surfaces as a Zod validation error BEFORE execute runs.
            // Faster + clearer feedback than the DB-layer reject, and
            // the message names the correct replacement tool per kind.
            message:
              'kind="person" → call saveContact instead; kind="company" → saveCompany; kind="deal" → saveDeal. These CRM tools write the entity row + specialization in one transaction and return the entityId you need for links.',
          }),
        name: z.string().min(1).max(280).describe('Display name.'),
        attributes: attributesShape,
        links: explicitLinksField,
      }),
    isConcurrencySafe: false,
    isReadOnly: false,

    async execute(input, context) {
      // Pre-write classifier check (PR 8 — B2 boundary integration).
      // Deterministic mismatch returns typed rejection so the LLM re-calls.
      if (deps.entityKindClassifier) {
        try {
          const decision = deps.entityKindClassifier.decide(
            { primary: input.name, attributes: input.attributes, proposed: input.kind },
            'tool',
          )
          if (decision.kind === 'override' && decision.match.value !== input.kind) {
            return {
              data: JSON.stringify({
                ok: false,
                reason: 'reclassified',
                blocking_rule_id: decision.match.rule_id,
                explanation: `Classifier rule ${decision.match.rule_id} indicates this input is a ${decision.match.value}, not a ${input.kind}.`,
                suggested_kind: decision.match.value,
              }),
              isError: true,
            }
          }
          if (decision.kind === 'blocked') {
            const block = decision.suppressedBy[0]
            return {
              data: JSON.stringify({
                ok: false,
                reason: 'reclassified',
                blocking_rule_id: block?.rule_id ?? 'unknown',
                explanation: block?.reason ?? 'Classifier blocked createEntity.',
              }),
              isError: true,
            }
          }
        } catch (err) {
          console.warn(`[workflow-tools] classifier check failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      try {
        const entity = await deps.entities.create({
          kind: input.kind as EntityKind,
          displayName: input.name,
          attributes: input.attributes ?? {},
          workspaceId: requireWorkspace(context.workspaceId),
          createdByUserId: context.userId,
          userId: context.userId,
          assistantId: context.assistantId,
          source: 'user',
        })
        const linksSummary = await applyExplicitLinks({
          entityLinks: deps.entityLinks,
          workspaceId: requireWorkspace(context.workspaceId),
          userId: context.userId,
          assistantId: context.assistantId,
          sourceKind: 'entity',
          sourceId: entity.id,
          source: 'user',
          links: input.links,
        })
        return {
          data: {
            id: entity.id,
            kind: entity.kind,
            displayName: entity.displayName,
            linksCreated: linksSummary.created,
            linksFailed: linksSummary.failed,
          },
        }
      } catch (err) {
        return {
          data: `createEntity failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })

  const createEdgeTool = buildTool({
    name: 'createEdge',
    description:
      'Create a graph edge between two EXISTING rows in the brain. ' +
      '**Exact input shape (copy this):**\n' +
      '  {\n' +
      '    "source_kind": "entity",\n' +
      '    "source_id":   "<entity_id from listContacts/listCompanies/listDeals>",\n' +
      '    "edge_type":   "works_at",\n' +
      '    "target_kind": "entity",\n' +
      '    "target_id":   "<entity_id from listContacts/listCompanies/listDeals>",\n' +
      '    "attributes":  {"role": "CTO"}\n' +
      '  }\n' +
      'Critical rules: (a) `source_kind` and `target_kind` are almost always `"entity"` — CRM rows back into the entities table; the contact/company/deal "kind" is NOT what goes here. (b) `source_id` / `target_id` must be the `entity_id` field from list/get results — NOT the contact/company/deal `id` (those are CRM row ids and will fail FK). (c) `edge_type` must come from this locked vocab: works_at, attended, discussed_in, represents, mentioned, signed_contract_with, competes_with, customer_since, engagement_of, target_investor, outreach_strategy_for, mutual_connection, discussed_with, depends_on, mentioned_publicly_at, target_competitor, documented_by, platform_engagement_for, replies_to. Domain-natural names like "co_founded", "founded", "affiliated_with" will be REJECTED — pick the closest from the vocab (cofounder relationship → use "works_at"; affiliated companies → "mutual_connection"). (d) `attributes` is a JSON object literal {"k": "v"} — NOT a stringified JSON. ' +
      'For NEW rows you are creating in the same turn, prefer `links: [...]` on the save tool (saveContact/saveCompany/saveDeal/saveMemory/saveTask/createEntity/fileWrite/fileSetMeta/updateSelfProfile) — that wires the edge in the same transaction and guarantees the source row exists.',
    inputSchema: z.object({
      source_kind: linkKindShape.describe('Almost always "entity". Synonyms (contact/company/deal/person/product/project) are auto-mapped to "entity".'),
      source_id: z.string().uuid().describe('The entity_id of the source row (NOT the CRM-row id).'),
      edge_type: z.enum(EDGE_TYPES).describe(
        'Relationship type from the locked vocab: ' + EDGE_TYPES.join(', ') + '.',
      ),
      target_kind: linkKindShape.describe('Almost always "entity". Synonyms are auto-mapped.'),
      target_id: z.string().uuid().describe('The entity_id of the target row (NOT the CRM-row id).'),
      attributes: attributesShape,
    }),
    isConcurrencySafe: false,
    isReadOnly: false,

    async execute(input, context) {
      try {
        const edge = await deps.entityLinks.create({
          sourceKind: input.source_kind,
          sourceId: input.source_id,
          targetKind: input.target_kind,
          targetId: input.target_id,
          edgeType: input.edge_type,
          attributes: input.attributes ?? {},
          workspaceId: requireWorkspace(context.workspaceId),
          userId: context.userId,
          assistantId: context.assistantId,
          source: 'user',
        })
        return { data: { id: edge.id, edgeType: edge.edgeType } }
      } catch (err) {
        return {
          data: `createEdge failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })

  const supersedeMemoryTool = buildTool({
    name: 'supersedeMemory',
    description:
      'Bi-temporally supersede (close out) every active memory in the ' +
      'workspace tagged with any of the given tags. Used to retire ' +
      'commitments once their goal is met.',
    inputSchema: z.object({
      tags: z
        .array(z.string().min(1))
        .min(1)
        .describe('Supersede memories whose tags overlap any of these.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,

    async execute(input, context) {
      try {
        const superseded = await deps.memories.supersedeByTags({
          workspaceId: requireWorkspace(context.workspaceId),
          tags: input.tags,
          now: new Date(),
        })
        return { data: { superseded } }
      } catch (err) {
        return {
          data: `supersedeMemory failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })

  return [createEntityTool, createEdgeTool, supersedeMemoryTool]
}
