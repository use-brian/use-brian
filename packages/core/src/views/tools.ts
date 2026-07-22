/**
 * Q5 Views chat tools.
 *
 * v1 ships **renderView** (free for all assistants — wedge property).
 * Phase 8 adds **saveView** with `requiresCapability: 'views'` for the
 * Pro-tier persistence gate.
 *
 * `renderView` builds an A2UI v0.8 ViewPayload from a BindingConfig and
 * returns it as the tool result. The chat route forwards the payload as
 * a structured content block; the apps/web message-list mounts a
 * <ViewRenderer/> for each payload (Phase 7 wiring).
 *
 * [COMP:views/tools]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import type { CrmStore } from '../crm/types.js'
import type { TaskStore } from '../tasks/types.js'
import type { WorkflowRunStore } from '../workflow/types.js'
import type { WorkspaceDirectoryStore } from '../workspace/types.js'
import {
  aggregateBindingSchema,
  resolveAggregation,
  type AggregateBinding,
} from './aggregations.js'
import { buildPayload } from './bindings.js'
import type { Block, ChartBlock, Page } from './blocks.js'
import { dataPage } from './blocks.js'
import type {
  A2UIWidget,
  BarChartWidget,
  KpiWidget,
  LineChartWidget,
  PieChartWidget,
  ViewPayload,
} from './a2ui.js'
import { bindingConfigSchema } from './schemas.js'
import type { BindingConfig, SavedViewStore } from './types.js'

export type ViewToolEvent =
  | { type: 'view_rendered'; viewId: string; entity: string; viewType: string }
  | { type: 'view_saved'; viewId: string; entity: string; viewType: string }
  | { type: 'chart_rendered'; viewId: string; entity: string; chartKind: 'kpi' | 'bar' | 'line' | 'pie' }

export type ViewToolEventContext = {
  userId: string
  assistantId: string
  sessionId: string
  channelType: string
}

export type ViewToolDeps = {
  taskStore: TaskStore
  crmStore: CrmStore
  workflowRunStore: WorkflowRunStore
  /**
   * Phase 1 (Notion-feel) — bindings call `batchGet` here to pre-resolve
   * `tasks.assignee_id` UUIDs into `{ name, avatarUrl, initials }` for
   * the renderer's PersonWidget cells. Required.
   */
  workspaceDirectory: WorkspaceDirectoryStore
  savedViewStore: SavedViewStore
  onEvent?: (event: ViewToolEvent, ctx: ViewToolEventContext) => void
}

function workspaceGate(workspaceId: string | null | undefined): { data: string; isError: true } | null {
  if (!workspaceId) {
    return {
      data: 'Views require a workspace. This assistant is not bound to one — switch to a workspace-scoped chat to render or save views.',
      isError: true,
    }
  }
  return null
}

function eventCtx(context: { userId: string; assistantId: string; sessionId: string; channelType: string }): ViewToolEventContext {
  return {
    userId: context.userId,
    assistantId: context.assistantId,
    sessionId: context.sessionId,
    channelType: context.channelType,
  }
}

/**
 * Surface useful detail when a `BindingConfig` union fails Zod
 * validation.
 *
 * Zod's plain `z.union` (which `bindingConfigSchema` is, because the
 * discriminator is two fields — `entity` + `viewType`) collapses every
 * variant failure into a single `invalid_union` issue with empty path
 * and the message "Invalid input". That's useless feedback for the
 * model — it retried with the same nonsense three times before giving
 * up (incident 2026-05-26).
 *
 * The fix: scan each `unionErrors[i]` and find the variant where the
 * model came closest — i.e. whose only complaints are NOT on the
 * `entity`/`viewType` discriminator fields. Those are the variants
 * that recognized the entity+viewType pair but rejected a required
 * field (e.g. `groupBy` missing on tasks/board). Report THOSE issues
 * so the model can self-correct on the next turn.
 */
function formatBindingError(error: z.ZodError, input: unknown): string[] {
  const inputObj =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)
      : {}
  const entity = typeof inputObj.entity === 'string' ? inputObj.entity : null
  const viewType = typeof inputObj.viewType === 'string' ? inputObj.viewType : null

  for (const issue of error.issues) {
    if (issue.code !== 'invalid_union') continue
    const variants = (issue as unknown as { unionErrors?: z.ZodError[] }).unionErrors ?? []
    // Find the variant whose issues don't complain about the discriminators
    // — that's the one the model came closest to satisfying.
    for (const variant of variants) {
      const touchesDiscriminator = variant.issues.some(
        (i) => i.path[0] === 'entity' || i.path[0] === 'viewType',
      )
      if (touchesDiscriminator) continue
      if (variant.issues.length === 0) continue
      return variant.issues.map((i) => {
        const path = i.path.length > 0 ? i.path.join('.') : '<root>'
        return `${path}: ${i.message}`
      })
    }
  }

  // Fallback — no variant matched the discriminators. Tell the model
  // explicitly which entity+viewType combinations exist.
  const prefix =
    entity && viewType
      ? `No binding variant for entity="${entity}" + viewType="${viewType}". `
      : 'Could not discriminate the binding. '
  return [
    prefix +
      'Valid combinations: tasks/table, tasks/board (groupBy:"status"), ' +
      'tasks/calendar (dateBy:"due"), ' +
      'contacts/table, companies/table, deals/table, deals/board (groupBy:"stage"), ' +
      'workflow_runs/table (filters.workflowId required).',
  ]
}

/**
 * Channel types whose sessions have no user in the loop — workflow
 * `assistant_call` consults (A2A callees) and legacy cron turns.
 *
 * Precedence in `renderView` / `renderChart` (the same three rungs, in
 * order):
 *   1. `context.docViewId` set → APPEND to that page. A doc anchor is a
 *      deliberate target — interactive doc chat and page-anchored workflow
 *      steps alike land their block on the anchored page.
 *   2. else headless → payload-only, NO draft. The caller wants the data;
 *      a draft nobody can save would just accumulate in the doc sidebar.
 *      (Incident: hourly workflow triggers whose callee rendered
 *      `workflow_runs/table` every run, re-creating a
 *      "workflow_runs/table — draft" page each hour, 2026-06-10.)
 *   3. else → create a draft (interactive chat from a non-doc surface).
 *
 * An anchored-but-unreachable page in a headless session falls 1 → 2
 * (payload-only), never into draft creation. See
 * docs/architecture/features/views.md → "Draft / saved lifecycle".
 */
const HEADLESS_CHANNEL_TYPES = new Set(['assistant-call', 'cron'])

/**
 * `renderView` is **not capability-gated** — every workspace member
 * sees inline structured tables in chat regardless of plan tier. That
 * holds the Q5 wedge for free users; persistence (saveView + the saved
 * pages at /w/<workspaceId>/p/<id>) is the Pro-tier gate.
 */
export function createRenderViewTool(deps: ViewToolDeps): Tool {
  return buildTool({
    name: 'renderView',
    description:
      'Render a Table, Board, or Calendar of the workspace\'s primitives — tasks / contacts / companies / deals / workflow runs. ' +
      'Use this when the user asks to "show me", "list", "kanban", a calendar/schedule of dated tasks, or any visual request — instead of writing a Markdown table. ' +
      'Result mounts inline in chat. When the session is anchored to a doc page, the table/board/calendar is appended to that page as a block; otherwise interactive chat persists it as a new draft page in the workspace\'s Pages sidebar (page URL: /w/<workspaceId>/p/<viewId>), and unanchored scheduled/automated sessions get the data only (no page is created). ' +
      '\n\n' +
      'ONLY these exact (entity, viewType) combinations are valid. Pick one VERBATIM; the tool rejects anything else: ' +
      '\n  • tasks/table — optional filters.{status[],assigneeId,tag,dueBefore,dueAfter}' +
      '\n  • tasks/board — REQUIRED groupBy:"status" — optional filters.{assigneeId,tag}' +
      '\n  • tasks/calendar — REQUIRED dateBy:"due" — optional filters.{status[],assigneeId,tag}. Month/week grid placing each task on its due date; tasks with no due date are not shown' +
      '\n  • contacts/table — optional filters.{query,tag,companyId}' +
      '\n  • companies/table — optional filters.{query,tag}' +
      '\n  • deals/table — optional filters.{stage[],contactId,companyId}' +
      '\n  • deals/board — REQUIRED groupBy:"stage" — optional filters.{contactId,companyId}' +
      '\n  • workflow_runs/table — REQUIRED filters.workflowId (UUID)' +
      '\n\n' +
      'Do NOT invent other viewTypes (no "kanban", "list", "gallery"). Do NOT call without the REQUIRED fields above for board/calendar variants.',
    inputSchema: z
      .object({
        binding: z.unknown().describe(
          'BindingConfig object. Copy one of these shapes literally: ' +
          '{"entity":"tasks","viewType":"table"} | ' +
          '{"entity":"tasks","viewType":"board","groupBy":"status"} | ' +
          '{"entity":"tasks","viewType":"calendar","dateBy":"due"} | ' +
          '{"entity":"contacts","viewType":"table"} | ' +
          '{"entity":"companies","viewType":"table"} | ' +
          '{"entity":"deals","viewType":"table"} | ' +
          '{"entity":"deals","viewType":"board","groupBy":"stage"} | ' +
          '{"entity":"workflow_runs","viewType":"table","filters":{"workflowId":"<uuid>"}}',
        ),
      })
      .describe('Wraps the BindingConfig under `binding` so future tool args can extend without breaking.'),
    isConcurrencySafe: false,
    isReadOnly: false,
    timeoutMs: 30_000,

    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const parsed = bindingConfigSchema.safeParse(input.binding)
      if (!parsed.success) {
        return {
          data: {
            ok: false,
            errors: formatBindingError(parsed.error, input.binding),
            hint:
              'Locked decisions: contacts/companies/workflow_runs are TABLE-ONLY. ' +
              'tasks/board requires groupBy:"status"; deals/board requires groupBy:"stage"; ' +
              'tasks/calendar requires dateBy:"due". ' +
              'workflow_runs/table requires filters.workflowId.',
          },
          isError: true,
        }
      }

      try {
        const binding = parsed.data as BindingConfig
        const payload = await buildPayload(binding, {
          taskStore: deps.taskStore,
          crmStore: deps.crmStore,
          workflowRunStore: deps.workflowRunStore,
          workspaceDirectory: deps.workspaceDirectory,
          userId: context.userId,
          workspaceId: context.workspaceId!,
        })

        // Notion-redesign: renderView lands a `data` block on a Doc
        // page. Three rungs (see HEADLESS_CHANNEL_TYPES for the rationale):
        //   1. **Append** — when the session is anchored to a page
        //      (`context.docViewId` set: interactive doc chat, or a
        //      page-anchored workflow `assistant_call` step), add a new
        //      block to that page. Doc drafts are containers; the user
        //      iterates on one workspace until they explicitly start
        //      another.
        //   2. **Headless, no reachable anchor** — payload only, never a
        //      draft (the hourly draft-minting incident guard).
        //   3. **Create** — interactive chat with no draft in scope mints
        //      a fresh draft seeded with this one block.
        // The chat client uses `viewId` + `action` to either refresh the
        // existing draft view or navigate to a freshly-created one.
        const blockId = newBlockId()
        const newBlock: Block = { kind: 'data', id: blockId, binding }
        const activeViewId = context.docViewId ?? null
        let viewId: string | undefined
        let action: 'appended' | 'created' = 'created'

        if (activeViewId) {
          // Append path — fetch current page, push, write back.
          const existing = await deps.savedViewStore.getPage(
            context.userId,
            activeViewId,
          )
          if (existing) {
            const nextPage: Page = { blocks: [...existing.blocks, newBlock] }
            const ok = await deps.savedViewStore.updatePage(
              context.userId,
              activeViewId,
              nextPage,
            )
            if (ok) {
              viewId = activeViewId
              action = 'appended'
            }
          }
          // If the active view isn't reachable (deleted / wrong user / RLS),
          // fall through: interactive sessions still get a new draft below;
          // headless sessions hit the payload-only guard instead.
        }

        // Headless sessions (workflow `assistant_call` consults, cron
        // turns) with no successful append get the payload only — no
        // draft page. There is no user in the loop to save or even see
        // the draft; persisting one per call litters the doc sidebar on
        // every scheduled fire.
        if (!viewId && HEADLESS_CHANNEL_TYPES.has(context.channelType)) {
          deps.onEvent?.({
            type: 'view_rendered',
            viewId: '',
            entity: binding.entity,
            viewType: binding.viewType,
          }, eventCtx(context))
          return {
            data: {
              kind: 'view_payload' as const,
              payload,
              entity: binding.entity,
              viewType: binding.viewType,
              action: 'rendered' as const,
            },
          }
        }

        if (!viewId) {
          const draftName = `${binding.entity}/${binding.viewType} — draft`
          const seedPage = dataPage(binding, blockId)
          try {
            const draft = await deps.savedViewStore.createDraft({
              userId: context.userId,
              workspaceId: context.workspaceId!,
              // Assistant-authored — see PageWriteActor (page self-loop guard).
              writtenBy: 'system',
              name: draftName,
              // Legacy `saved_views.entity` is the closed 5-enum; a custom
              // binding defaults it to 'tasks' (block binding is authoritative).
              entity: binding.entity === 'custom' ? 'tasks' : binding.entity,
              viewType: binding.viewType,
              binding,
              page: seedPage,
            })
            viewId = draft.id
            action = 'created'
          } catch (err) {
            // Draft creation failure: surface a clean tool error rather
            // than silently dropping the user's request. The model will
            // tell the user it couldn't render.
            console.warn('[renderView] draft creation failed:', err)
            return {
              data: `Failed to create draft: ${
                err instanceof Error ? err.message : String(err)
              }`,
              isError: true,
            }
          }
        }

        deps.onEvent?.({
          type: 'view_rendered',
          viewId: viewId ?? '',
          entity: binding.entity,
          viewType: binding.viewType,
        }, eventCtx(context))

        return {
          data: {
            kind: 'view_payload' as const,
            payload,
            entity: binding.entity,
            viewType: binding.viewType,
            action,
            ...(viewId ? { viewId } : {}),
          },
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          data: `Failed to render view: ${message}`,
          isError: true,
        }
      }
    },
  })
}

function newBlockId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `block-${Date.now()}`
}

// ── renderChart (Phase 4) ─────────────────────────────────────────────

const chartKindSchema = z.enum(['kpi', 'bar', 'line', 'pie'])

/**
 * Build the A2UI chart widget from an aggregation result + chart kind.
 * Mirrors the projection in `page-render.ts`'s `chartWidgetFromResult`
 * but keeps both call sites independent (the chat tool returns the
 * widget inline before the page is fetched again; the page renderer
 * resolves the same shape lazily on `GET /api/views/:id/payload`).
 */
function buildChartWidget(
  kind: 'kpi' | 'bar' | 'line' | 'pie',
  binding: AggregateBinding,
  title: string | undefined,
  result: { groups: { label: string; value: number }[]; total: number },
): A2UIWidget {
  switch (kind) {
    case 'kpi': {
      const widget: KpiWidget = {
        type: 'kpi',
        label: title ?? binding.groupBy,
        value: result.total,
        format: 'integer',
      }
      return widget
    }
    case 'bar': {
      const widget: BarChartWidget = {
        type: 'chart_bar',
        ...(title ? { title } : {}),
        data: result.groups.map((g) => ({ label: g.label, value: g.value })),
      }
      return widget
    }
    case 'line': {
      const widget: LineChartWidget = {
        type: 'chart_line',
        ...(title ? { title } : {}),
        series: [
          {
            name: binding.measure ?? 'count',
            points: result.groups.map((g) => ({ x: g.label, y: g.value })),
          },
        ],
      }
      return widget
    }
    case 'pie': {
      const widget: PieChartWidget = {
        type: 'chart_pie',
        ...(title ? { title } : {}),
        slices: result.groups.map((g) => ({ label: g.label, value: g.value })),
      }
      return widget
    }
  }
}

/**
 * `renderChart` mirrors `renderView`: a free-tier chat tool that
 * builds an A2UI chart widget from an aggregation binding, persists
 * the chart as a single-block draft page, and returns the resolved
 * widget for inline-in-chat render. The user can click through to the
 * full page; if they don't, the prune worker collects the draft after
 * 30 days.
 *
 * The draft uses a synthetic `entity`/`viewType` pair on
 * `saved_views` (`entity = binding.entity`, `viewType = 'table'`) so
 * sidebar listings continue to slot the row into the right bucket. The
 * actual chart shape lives in `page.blocks[0]` as a `ChartBlock`.
 */
export function createRenderChartTool(deps: ViewToolDeps): Tool {
  return buildTool({
    name: 'renderChart',
    description:
      'Render a KPI tile, bar chart, line chart, or pie chart from the workspace primitives ' +
      '(tasks / deals / contacts / companies). Use this when the user asks "show me a chart of…", ' +
      '"how many deals per stage", "trend of tasks closed this month", or any visual aggregation. ' +
      '\n\n' +
      'Aggregation ops: count_by (count rows per group), sum_by (sum a numeric measure per group), ' +
      'avg_by (average a measure per group), series_by_date (bucket by day/week/month). ' +
      '\n\n' +
      'Chart kinds: ' +
      '\n  • "kpi" — big number (total). Pair with op:"count_by" for "total deals", or sum_by for revenue. ' +
      '\n  • "bar" — categorical breakdown. e.g. tasks count_by status; deals sum_by stage measure:amount.' +
      '\n  • "line" — time series. ALWAYS use op:"series_by_date" + bucket:"day"|"week"|"month".' +
      '\n  • "pie" — share-of-total breakdown. Same shape as bar; pick pie when proportions matter.' +
      '\n\n' +
      'sum_by and avg_by REQUIRE a `measure` field name (e.g. measure:"amount" on deals). ' +
      'series_by_date REQUIRES a date-typed groupBy field (e.g. groupBy:"closeDate" on deals, ' +
      '"due" on tasks, "updatedAt" on any entity). ' +
      '\n\n' +
      'The result mounts inline in chat AND persists as a draft page in the workspace\'s Pages sidebar (page URL: /w/<workspaceId>/p/<viewId>).',
    inputSchema: z.object({
      kind: chartKindSchema.describe('Picks the chart widget shape.'),
      title: z.string().min(0).max(256).optional().describe(
        'Optional title rendered above the chart. Defaults to the groupBy field name for KPIs.',
      ),
      binding: z.unknown().describe(
        'AggregateBinding object. Examples: ' +
        '{"entity":"tasks","op":"count_by","groupBy":"status"} | ' +
        '{"entity":"deals","op":"sum_by","groupBy":"stage","measure":"amount"} | ' +
        '{"entity":"deals","op":"series_by_date","groupBy":"closeDate","bucket":"week","measure":"amount"}.',
      ),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    timeoutMs: 30_000,

    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const parsed = aggregateBindingSchema.safeParse(input.binding)
      if (!parsed.success) {
        return {
          data: {
            ok: false,
            errors: parsed.error.issues.map((i) => {
              const path = i.path.length > 0 ? i.path.join('.') : '<root>'
              return `${path}: ${i.message}`
            }),
            hint:
              'Required: entity (tasks|deals|contacts|companies), op (count_by|sum_by|avg_by|series_by_date), ' +
              'groupBy (field name). sum_by/avg_by also require measure. series_by_date uses bucket (day|week|month).',
          },
          isError: true,
        }
      }

      const binding: AggregateBinding = parsed.data
      const title = input.title

      try {
        const aggregationResult = await resolveAggregation(binding, {
          taskStore: deps.taskStore,
          crmStore: deps.crmStore,
          accessContext: {
            workspaceId: context.workspaceId!,
            userId: context.userId,
            assistantId: context.userId,
            assistantKind: 'primary',
            clearance: undefined,
          },
        })

        const widget = buildChartWidget(input.kind, binding, title, aggregationResult)
        const payload: ViewPayload = { a2ui: '0.8', root: widget }

        // The block both the append and create paths persist.
        const blockId = (globalThis.crypto?.randomUUID?.() ?? `block-${Date.now()}`)
        const chartBlock: ChartBlock = {
          kind: 'chart',
          id: blockId,
          chartType: input.kind,
          ...(title ? { title } : {}),
          binding,
        }

        // Anchored sessions append the chart to the anchored page —
        // mirrors renderView's append rung ("doc drafts are containers";
        // a page-anchored workflow step lands its chart on its page).
        // Previously renderChart always minted a separate draft even with
        // an active doc anchor; appending is the deliberate alignment.
        const activeViewId = context.docViewId ?? null
        if (activeViewId) {
          const existing = await deps.savedViewStore.getPage(context.userId, activeViewId)
          if (existing) {
            const ok = await deps.savedViewStore.updatePage(
              context.userId,
              activeViewId,
              { blocks: [...existing.blocks, chartBlock] },
            )
            if (ok) {
              deps.onEvent?.({
                type: 'chart_rendered',
                viewId: activeViewId,
                entity: binding.entity,
                chartKind: input.kind,
              }, eventCtx(context))
              return {
                data: {
                  kind: 'view_payload' as const,
                  payload,
                  entity: binding.entity,
                  viewType: 'chart',
                  chartKind: input.kind,
                  action: 'appended' as const,
                  viewId: activeViewId,
                },
              }
            }
          }
          // Unreachable anchor: interactive sessions fall through to the
          // draft below; headless sessions hit the payload-only guard.
        }

        // Headless sessions with no successful append get the payload only —
        // no draft page. Mirrors renderView; see HEADLESS_CHANNEL_TYPES.
        if (HEADLESS_CHANNEL_TYPES.has(context.channelType)) {
          deps.onEvent?.({
            type: 'chart_rendered',
            viewId: '',
            entity: binding.entity,
            chartKind: input.kind,
          }, eventCtx(context))
          return {
            data: {
              kind: 'view_payload' as const,
              payload,
              entity: binding.entity,
              viewType: 'chart',
              chartKind: input.kind,
            },
          }
        }

        // Persist as a single-chart-block draft page so the user can
        // open it at /w/<workspaceId>/p/<viewId> (the Pages sidebar).
        // The seam mirrors renderView's draft flow.
        const seedPage: Page = { blocks: [chartBlock] }
        const draftName = title
          ?? `${binding.entity} ${input.kind} chart — draft`

        let viewId: string | undefined
        try {
          // We must keep the SavedView entity / viewType columns
          // populated; bias to "table" so the sidebar listing puts the
          // chart alongside other workspace primitives. The actual
          // chart payload lives in `page.blocks[0]`.
          const draft = await deps.savedViewStore.createDraft({
            userId: context.userId,
            workspaceId: context.workspaceId!,
            // Assistant-authored — see PageWriteActor (page self-loop guard).
            writtenBy: 'system',
            name: draftName,
            entity: binding.entity,
            viewType: 'table',
            // Synthetic binding so the legacy `binding JSONB` column
            // stays a valid `BindingConfig` shape during the back-compat
            // window. Chart pages route through `page`, not `binding`.
            binding: { entity: binding.entity, viewType: 'table' } as BindingConfig,
            page: seedPage,
          })
          viewId = draft.id
        } catch (err) {
          console.warn('[renderChart] draft creation failed; skipping deep-link:', err)
        }

        deps.onEvent?.({
          type: 'chart_rendered',
          viewId: viewId ?? '',
          entity: binding.entity,
          chartKind: input.kind,
        }, eventCtx(context))

        return {
          data: {
            kind: 'view_payload' as const,
            payload,
            entity: binding.entity,
            viewType: 'chart',
            chartKind: input.kind,
            ...(viewId ? { viewId } : {}),
          },
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          data: `Failed to render chart: ${message}`,
          isError: true,
        }
      }
    },
  })
}

/**
 * `saveView` IS capability-gated by `requiresCapability: 'views'` —
 * §17 grants this to paid-plan users only (see migration 118 backfill +
 * Phase 8 wiring). Free-tier assistants don't see this tool in their
 * tool list.
 */
export function createSaveViewTool(deps: ViewToolDeps): Tool {
  return buildTool({
    name: 'saveView',
    description:
      'Persist a previously-rendered view as a saved view in this workspace. ' +
      'Use after the user explicitly asks to "save this as a view" / "save it" / ' +
      'similar. Pass the SAME binding the most recent renderView used so the ' +
      'saved view round-trips. The result includes a deep-link URL the user can ' +
      'visit later.',
    inputSchema: z.object({
      name: z.string().min(1).max(256).describe('Human-readable name shown in the workspace\'s Pages sidebar.'),
      description: z.string().max(2000).optional().describe('Optional one-liner.'),
      binding: z.unknown().describe('Same BindingConfig shape as renderView.'),
    }),
    requiresCapability: 'views',
    timeoutMs: 30_000,

    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const parsed = bindingConfigSchema.safeParse(input.binding)
      if (!parsed.success) {
        return {
          data: {
            ok: false,
            errors: formatBindingError(parsed.error, input.binding),
          },
          isError: true,
        }
      }

      try {
        const created = await deps.savedViewStore.create({
          userId: context.userId,
          workspaceId: context.workspaceId!,
          // Assistant-authored — see PageWriteActor (page self-loop guard).
          writtenBy: 'system',
          name: input.name,
          description: input.description ?? null,
          binding: parsed.data as BindingConfig,
        })

        deps.onEvent?.({
          type: 'view_saved',
          viewId: created.id,
          entity: parsed.data.entity,
          viewType: parsed.data.viewType,
        }, eventCtx(context))

        return {
          data: {
            id: created.id,
            name: created.name,
            entity: created.entity,
            viewType: created.viewType,
            url: `/w/${created.workspaceId}/p/${created.id}`,
          },
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { data: `Failed to save view: ${message}`, isError: true }
      }
    },
  })
}

export function createViewTools(deps: ViewToolDeps): {
  renderView: Tool
  renderChart: Tool
  saveView: Tool
} {
  return {
    renderView: createRenderViewTool(deps),
    renderChart: createRenderChartTool(deps),
    saveView: createSaveViewTool(deps),
  }
}
