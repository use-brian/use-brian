/**
 * Agent-mediated ingest-rule management tools.
 *
 * Five chat tools that let the model + operator co-edit the Pipeline C
 * routing rules for a connected source (Gmail / GitHub / Calendar /
 * Fathom / Slack):
 *
 *   - `listConnectorInstances` — names the available CIs by provider
 *   - `listIngestRules` — current ordered rule list for one CI
 *   - `addIngestRule` — append (or insert at a position) a new rule
 *   - `updateIngestRule` — patch an existing rule
 *   - `deleteIngestRule` — remove a rule
 *
 * The store port is RLS-gated — concrete adapters in `packages/api/src/db`
 * call `queryWithRLS(actingUserId, ...)` so a member can only edit rules
 * for CIs they can already see. Workspace-admin role enforcement on top
 * of RLS is the API-layer adapter's responsibility (the store can pass
 * the acting user's role to the engine if richer policy is needed).
 *
 * Spec: docs/architecture/brain/ingest-pipeline.md → "Agent-mediated
 * rule management" + "Per-rule Episode sensitivity override".
 *
 * [COMP:brain/ingest-tools]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import type { RoutingMode, RuleEpisodeSensitivity } from './engine.js'
import {
  INGEST_SOURCE_PROVIDERS,
  type IngestSourceProvider,
} from './default-rules.js'

// ── Public surface ──────────────────────────────────────────────

export type ConnectorInstanceSummary = {
  id: string
  scope: 'user' | 'workspace'
  provider: IngestSourceProvider
  label: string
  ingestionEnabled: boolean
}

export type IngestRuleSummary = {
  id: string
  connectorInstanceId: string
  source: string
  ruleOrder: number
  filterType: string
  filterParams: Record<string, unknown>
  routingMode: RoutingMode
  routingSchedule: string | null
  routingTimezone: string
  alert: boolean
  episodeSensitivity: RuleEpisodeSensitivity | null
}

export type AddIngestRuleInput = {
  connectorInstanceId: string
  filterType: string
  filterParams: Record<string, unknown>
  routingMode: RoutingMode
  routingSchedule?: string | null
  routingTimezone?: string
  alert?: boolean
  episodeSensitivity?: RuleEpisodeSensitivity | null
  /** When omitted, the rule is appended at the end. */
  ruleOrder?: number
}

export type UpdateIngestRuleInput = {
  ruleId: string
  patch: {
    filterType?: string
    filterParams?: Record<string, unknown>
    routingMode?: RoutingMode
    routingSchedule?: string | null
    routingTimezone?: string
    alert?: boolean
    episodeSensitivity?: RuleEpisodeSensitivity | null
    ruleOrder?: number
  }
}

/**
 * Store port the tools call into. The API adapter (`packages/api/src/db/
 * ingest-rules-store.ts`) implements this via RLS-gated SQL — the acting
 * user can only touch CIs + rules they can already see.
 *
 * `listConnectorInstances` returns ingest-capable CIs (per
 * `INGEST_SOURCE_PROVIDERS`); the adapter is expected to filter the
 * provider list itself.
 */
export type IngestRuleEditorStore = {
  listConnectorInstances(
    actingUserId: string,
    opts: { provider?: IngestSourceProvider; workspaceId?: string },
  ): Promise<ConnectorInstanceSummary[]>
  listRules(
    actingUserId: string,
    connectorInstanceId: string,
  ): Promise<IngestRuleSummary[]>
  addRule(
    actingUserId: string,
    input: AddIngestRuleInput,
  ): Promise<IngestRuleSummary>
  updateRule(
    actingUserId: string,
    input: UpdateIngestRuleInput,
  ): Promise<IngestRuleSummary>
  deleteRule(actingUserId: string, ruleId: string): Promise<void>
}

// ── Schemas ─────────────────────────────────────────────────────

const sensitivitySchema = z.enum(['public', 'internal', 'confidential'])
const routingModeSchema = z.enum(['realtime', 'scheduled', 'drop'])

const filterParamsSchema = z.record(z.unknown())

const addInputSchema = z
  .object({
    connector_instance_id: z.string().uuid(),
    filter_type: z.string().min(1),
    filter_params: filterParamsSchema.optional(),
    routing_mode: routingModeSchema,
    routing_schedule: z.string().min(1).nullish(),
    routing_timezone: z.string().min(1).optional(),
    alert: z.boolean().optional(),
    episode_sensitivity: sensitivitySchema.nullish(),
    rule_order: z.number().int().min(0).optional(),
  })
  .strict()

const updateInputSchema = z
  .object({
    rule_id: z.string().uuid(),
    patch: z
      .object({
        filter_type: z.string().min(1).optional(),
        filter_params: filterParamsSchema.optional(),
        routing_mode: routingModeSchema.optional(),
        routing_schedule: z.string().min(1).nullish(),
        routing_timezone: z.string().min(1).optional(),
        alert: z.boolean().optional(),
        episode_sensitivity: sensitivitySchema.nullish(),
        rule_order: z.number().int().min(0).optional(),
      })
      .strict()
      .refine((p) => Object.keys(p).length > 0, {
        message: 'patch must include at least one field',
      }),
  })
  .strict()

const deleteInputSchema = z
  .object({
    rule_id: z.string().uuid(),
  })
  .strict()

const listRulesInputSchema = z
  .object({
    connector_instance_id: z.string().uuid(),
  })
  .strict()

const listInstancesInputSchema = z
  .object({
    provider: z.enum(INGEST_SOURCE_PROVIDERS).optional(),
  })
  .strict()

// ── Factory ─────────────────────────────────────────────────────

export type IngestRuleTools = {
  listConnectorInstances: Tool
  listIngestRules: Tool
  addIngestRule: Tool
  updateIngestRule: Tool
  deleteIngestRule: Tool
}

export function createIngestRuleTools(store: IngestRuleEditorStore): IngestRuleTools {
  const listConnectorInstances = buildTool({
    name: 'listConnectorInstances',
    description:
      'List the connected source instances (Gmail, GitHub, Calendar, Fathom, Slack) the brain can ingest from. ' +
      'Each row carries the instance id (needed by listIngestRules / addIngestRule), provider, human label (e.g. team or account name), scope (user / workspace), and whether ingestion is currently enabled. ' +
      'Use this before any rule edit so you have a valid `connector_instance_id`. Optional `provider` narrows the list.',
    inputSchema: listInstancesInputSchema,
    isConcurrencySafe: true,
    isReadOnly: true,
    async execute(input, context) {
      const rows = await store.listConnectorInstances(context.userId, {
        provider: input.provider as IngestSourceProvider | undefined,
        workspaceId: context.workspaceId ?? undefined,
      })
      return { data: rows }
    },
  })

  const listIngestRules = buildTool({
    name: 'listIngestRules',
    description:
      'Return the ordered rule list for one connector instance. First-match-wins; each rule pairs a filter (e.g. `is_dm`, `channel_match`, `keyword_match`) with a routing decision (`realtime` / `scheduled` / `drop`) and an optional `episode_sensitivity` override. ' +
      'Inspect this before adding or updating a rule so you can pick a sensible `rule_order` and avoid duplicates.',
    inputSchema: listRulesInputSchema,
    isConcurrencySafe: true,
    isReadOnly: true,
    async execute(input, context) {
      const rules = await store.listRules(context.userId, input.connector_instance_id)
      return { data: rules }
    },
  })

  const addIngestRule = buildTool({
    name: 'addIngestRule',
    description:
      'Add a new ingest rule on a connector instance. Required fields: `connector_instance_id`, `filter_type` (e.g. `channel_match`, `is_dm`, `always`), `routing_mode` (`realtime` / `scheduled` / `drop`). For `scheduled` mode include a 5-field cron `routing_schedule` (e.g. `0 9 * * 1-5` = 09:00 on weekdays). ' +
      '`episode_sensitivity` (`public` / `internal` / `confidential`) lifts the tier of the produced Episode — use `confidential` for rules that match high-trust channels like #founder. ' +
      'Optional `rule_order` inserts at a specific position; otherwise the rule is appended. `filter_params` is a free-form object — its keys depend on `filter_type` (e.g. `{ values: [\'C-founder\'] }` for `channel_match`).',
    inputSchema: addInputSchema,
    isConcurrencySafe: false,
    isReadOnly: false,
    async execute(input, context) {
      const created = await store.addRule(context.userId, {
        connectorInstanceId: input.connector_instance_id,
        filterType: input.filter_type,
        filterParams: input.filter_params ?? {},
        routingMode: input.routing_mode,
        routingSchedule: input.routing_schedule ?? null,
        routingTimezone: input.routing_timezone,
        alert: input.alert,
        episodeSensitivity: input.episode_sensitivity ?? null,
        ruleOrder: input.rule_order,
      })
      return { data: created }
    },
  })

  const updateIngestRule = buildTool({
    name: 'updateIngestRule',
    description:
      'Patch an existing ingest rule by id. Only the supplied fields change; omitted fields stay as-is. Use this to flip `episode_sensitivity`, change a cron `routing_schedule`, swap `routing_mode`, etc. ' +
      'Pass `episode_sensitivity: null` (literal null, not omitted) to clear the override and inherit the source default.',
    inputSchema: updateInputSchema,
    isConcurrencySafe: false,
    isReadOnly: false,
    async execute(input, context) {
      const patch = input.patch
      const updated = await store.updateRule(context.userId, {
        ruleId: input.rule_id,
        patch: {
          filterType: patch.filter_type,
          filterParams: patch.filter_params,
          routingMode: patch.routing_mode,
          routingSchedule: patch.routing_schedule,
          routingTimezone: patch.routing_timezone,
          alert: patch.alert,
          episodeSensitivity: patch.episode_sensitivity,
          ruleOrder: patch.rule_order,
        },
      })
      return { data: updated }
    },
  })

  const deleteIngestRule = buildTool({
    name: 'deleteIngestRule',
    description:
      'Delete an ingest rule by id. Surrounding rules keep their `rule_order` — gaps in the ordering are harmless (the engine reads ascending). Pending batches keyed on the deleted rule cascade away.',
    inputSchema: deleteInputSchema,
    isConcurrencySafe: false,
    isReadOnly: false,
    async execute(input, context) {
      await store.deleteRule(context.userId, input.rule_id)
      return { data: { deleted: input.rule_id } }
    },
  })

  return {
    listConnectorInstances,
    listIngestRules,
    addIngestRule,
    updateIngestRule,
    deleteIngestRule,
  }
}
