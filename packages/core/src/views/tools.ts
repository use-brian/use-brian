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
import { toolFailure } from '../tools/tool-failure.js'
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
import { renderPayloadText } from './text-render.js'
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
  /**
   * Absolute page URL builder (`https://app…/w/<workspaceId>/p/<viewId>`).
   * Wired from boot (AUTHED_APP_URL ?? APP_URL, same resolution as the
   * computer-use take-over link). When a page is created or appended on a
   * channel outside VIEW_MOUNT_CHANNELS, the tool result carries this URL
   * and instructs the model to include it — out-app the page is reachable
   * NOWHERE else. Absent (tests, minimal boots) → a relative `/w/…/p/…`
   * path is returned instead.
   */
  pageUrl?: (workspaceId: string, viewId: string) => string
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
 * The (entity, viewType) catalogue `bindingConfigSchema` accepts, written
 * once so `renderView` and `saveView` reject against the SAME list the model
 * has to choose from.
 */
const VALID_BINDINGS =
  'Valid bindings: tasks/table; tasks/board (REQUIRES groupBy:"status"); tasks/calendar (REQUIRES dateBy:"due"); ' +
  'contacts/table; companies/table; deals/table; deals/board (REQUIRES groupBy:"stage"); ' +
  'workflow_runs/table (REQUIRES filters.workflowId). ' +
  'contacts, companies and workflow_runs are TABLE-ONLY — there is no board or calendar for them.'

/**
 * Message-first rendering of a binding rejection.
 *
 * These three sites used to return the object
 * `{ ok: false, errors: [...], hint: "..." }`, which the executor serializes
 * as JSON (multi-key failure objects are kept verbatim) — so the model had to
 * parse JSON to read prose that was already prose, and the `ok: false` key
 * carried nothing `isError` had not already said. The failure is now TEXT:
 * the diagnosis first (which tool, what did not happen, why), then the
 * load-bearing tail (the per-variant issues, the catalogue of valid shapes),
 * then the retry verdict.
 *
 * See docs/architecture/engine/tool-executor.md → "Failure copy".
 */
function bindingRejection(params: {
  tool: string
  /** What did NOT happen because the binding was rejected. */
  effect: string
  /** Per-variant validation issues, already formatted `path: message`. */
  errors: string[]
  /** The shapes this argument is allowed to take. */
  guidance: string
}): { data: string; isError: true } {
  const detail =
    params.errors.length > 0
      ? `\nRejected because:\n${params.errors.map((e) => `  - ${e}`).join('\n')}`
      : ''
  return {
    data:
      `${params.tool} did not run: the \`binding\` argument is not a shape this tool accepts, so ${params.effect}.` +
      detail +
      `\n${params.guidance}` +
      `\nRewrite \`binding\` as one of those shapes and call ${params.tool} again. Re-sending this exact binding will be rejected the same way.`,
    isError: true,
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
 * Precedence in `renderView` / `renderChart` (the same four rungs, in
 * order):
 *   1. `context.docViewId` set → APPEND to that page. A doc anchor is a
 *      deliberate target — interactive doc chat and page-anchored workflow
 *      steps alike land their block on the anchored page. Out-app, the
 *      result also carries the page URL (see VIEW_MOUNT_CHANNELS).
 *   2. else headless → payload-only, NO draft. The caller wants the data;
 *      a draft nobody can save would just accumulate in the doc sidebar.
 *      (Incident: hourly workflow triggers whose callee rendered
 *      `workflow_runs/table` every run, re-creating a
 *      "workflow_runs/table — draft" page each hour, 2026-06-10.)
 *   3. else interactive but OUTSIDE VIEW_MOUNT_CHANNELS (Slack, Telegram,
 *      …, API turns) → payload + a paste-ready `textRendering`, NO draft
 *      unless the model passed `createPage: true` on the user's explicit
 *      ask. When it did, the draft is minted (reusing an identical-binding
 *      draft when one exists) and the result carries the absolute page
 *      URL the reply MUST include. (Incident: four invisible
 *      "deals/board — draft" / "tasks/table — draft" pages minted from
 *      Slack asks like "what pipeline do we have", while the assistant
 *      claimed the board was "embedded in this chat above", 2026-08-19.)
 *   4. else (web app chat) → create a draft. The floating-chat client
 *      consumes the `view_payload` SSE event and auto-navigates to the
 *      new draft — in-app, the page IS the display surface.
 *
 * An anchored-but-unreachable page in a headless session falls 1 → 2
 * (payload-only), never into draft creation. See
 * docs/architecture/features/views.md → "Draft / saved lifecycle".
 */
const HEADLESS_CHANNEL_TYPES = new Set(['assistant-call', 'cron'])

/**
 * The channels whose CLIENT mounts the draft page — today only the web
 * app chat (`floating-chat.tsx` listens for `view_payload` and navigates
 * to the created draft; "we never inline-render the widget in chat").
 * Everywhere else — messaging adapters, the public/API turn routes,
 * workflow deliver turns — nothing can render an A2UI payload or open
 * the Pages sidebar, so a silently-minted draft is an invisible page the
 * user never asked for. Deliberately an ALLOWLIST: a future channel
 * defaults to the honest rung 3 above, not to silent slop.
 */
const VIEW_MOUNT_CHANNELS = new Set(['web'])

/**
 * Model-facing follow-up attached to out-app results that carry a page
 * URL. Kept as one constant so renderView / renderChart / saveView give
 * the model the same instruction.
 */
const OUT_APP_LINK_NOTE =
  'This chat cannot display the interactive view. Your reply MUST include the `url` above (it is the only way the user can reach this page) and should present the data itself using `textRendering` when one is provided.'

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
      'What the user sees depends on the channel. Web app chat: the result is saved as a draft page in the Pages sidebar and the app opens it — that page is how the view is displayed. ' +
      'Anchored doc sessions: the table/board/calendar is appended to the anchored page as a block. ' +
      'Every other channel (Slack, Telegram, Feishu/Lark, WhatsApp, Discord, API) CANNOT display an interactive view: the result instead includes a ready-to-paste `textRendering` you must use to present the data in your reply, and NO page is created unless you pass createPage:true; when a page is created or appended out-app the result carries a `url` your reply must include. ' +
      'Unanchored scheduled/automated sessions get the data only (no page is created). ' +
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
        createPage: z
          .boolean()
          .optional()
          .describe(
            'Only consulted OUTSIDE the web app chat (messaging channels, API turns). Set true ONLY when the user explicitly asked for a page they can open later ("create a board page", "save this as a page I can check"). A plain "show me…" ask must leave this unset — the data is returned with a textRendering and no page is created. In the web app chat this field is ignored (the draft page is how the view is displayed).',
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
        return bindingRejection({
          tool: 'renderView',
          effect: 'nothing was rendered and no page was created',
          errors: formatBindingError(parsed.error, input.binding),
          guidance: VALID_BINDINGS,
        })
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
        const outApp = !VIEW_MOUNT_CHANNELS.has(context.channelType)
        let viewId: string | undefined
        let action: 'appended' | 'created' | 'reused' = 'created'

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

        // Rung 3 — interactive but out-app (Slack, Telegram, API, …) with
        // no explicit page ask: the user wanted the data in THIS chat, so
        // return it as paste-ready text and mint nothing. A silently-minted
        // draft here is a page nobody can see (the 2026-08-19 Slack slop).
        if (!viewId && outApp && input.createPage !== true) {
          deps.onEvent?.({
            type: 'view_rendered',
            viewId: '',
            entity: binding.entity,
            viewType: binding.viewType,
          }, eventCtx(context))
          const textRendering = renderPayloadText(payload)
          return {
            data: {
              kind: 'view_payload' as const,
              payload,
              entity: binding.entity,
              viewType: binding.viewType,
              action: 'rendered' as const,
              ...(textRendering ? { textRendering } : {}),
              note:
                'No page was created. This chat cannot display interactive views. Present the data in your reply using textRendering (paste it, lightly adapted to the channel). Only if the user explicitly asks for a page they can open later, call renderView again with createPage: true.',
            },
          }
        }

        // Out-app explicit page ask: an identical-binding draft already in
        // the sidebar IS the page the user means — data blocks are live
        // bindings, so a same-binding draft renders identically. Reuse it
        // instead of minting the duplicate rows the incident left behind.
        if (!viewId && outApp && deps.savedViewStore.findDraftByBinding) {
          const existing = await deps.savedViewStore.findDraftByBinding(
            context.userId,
            context.workspaceId!,
            binding,
          )
          if (existing) {
            viewId = existing.id
            action = 'reused'
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
            return toolFailure(err, {
              tool: 'renderView',
              action: 'saving the rendered view as a draft page',
              mutating: true,
              next: 'The view itself rendered fine; the draft page could not be created. Tell the user the page was not created rather than linking to one.',
            })
          }
        }

        deps.onEvent?.({
          type: 'view_rendered',
          viewId: viewId ?? '',
          entity: binding.entity,
          viewType: binding.viewType,
        }, eventCtx(context))

        // Out-app, a page the user cannot navigate to is a page that does
        // not exist: whenever one was created/appended/reused, the result
        // carries the absolute URL and the reply must include it.
        const outAppExtras =
          outApp && viewId
            ? {
                url:
                  deps.pageUrl?.(context.workspaceId!, viewId) ??
                  `/w/${context.workspaceId}/p/${viewId}`,
                ...(() => {
                  const textRendering = renderPayloadText(payload)
                  return textRendering ? { textRendering } : {}
                })(),
                note: OUT_APP_LINK_NOTE,
              }
            : {}

        return {
          data: {
            kind: 'view_payload' as const,
            payload,
            entity: binding.entity,
            viewType: binding.viewType,
            action,
            ...(viewId ? { viewId } : {}),
            ...outAppExtras,
          },
        }
      } catch (err) {
        return toolFailure(err, {
          tool: 'renderView',
          target: 'the requested view binding',
          next: 'No page was created.',
        })
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
      'What the user sees depends on the channel. Web app chat: the chart persists as a draft page in the Pages sidebar and the app opens it. ' +
      'Anchored doc sessions: the chart block is appended to the anchored page. ' +
      'Every other channel (Slack, Telegram, Feishu/Lark, WhatsApp, Discord, API) CANNOT display a chart: the result includes a `textRendering` (label: value lines) to present in your reply, NO page is created unless you pass createPage:true, and any created/appended page comes back with a `url` your reply must include.',
    inputSchema: z.object({
      kind: chartKindSchema.describe('Picks the chart widget shape.'),
      createPage: z
        .boolean()
        .optional()
        .describe(
          'Only consulted OUTSIDE the web app chat. Set true ONLY when the user explicitly asked for a page they can open later. A plain "how many…" / "chart of…" ask must leave this unset. Ignored in the web app chat.',
        ),
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
        return bindingRejection({
          tool: 'renderChart',
          effect: 'no chart was rendered and no page was created',
          errors: parsed.error.issues.map((i) => {
            const path = i.path.length > 0 ? i.path.join('.') : '<root>'
            return `${path}: ${i.message}`
          }),
          guidance:
            'An AggregateBinding REQUIRES: entity (tasks|deals|contacts|companies), ' +
            'op (count_by|sum_by|avg_by|series_by_date), and groupBy (a field name on that entity). ' +
            'sum_by and avg_by also require `measure`; series_by_date also takes `bucket` (day|week|month). ' +
            'workflow_runs cannot be aggregated.',
        })
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
        const outApp = !VIEW_MOUNT_CHANNELS.has(context.channelType)
        // Same out-app contract as renderView: a page the user cannot
        // navigate to does not exist, so appends/creates outside the web
        // app carry the absolute URL + the link instruction.
        const outAppExtrasFor = (viewId: string) =>
          outApp
            ? {
                url:
                  deps.pageUrl?.(context.workspaceId!, viewId) ??
                  `/w/${context.workspaceId}/p/${viewId}`,
                ...(() => {
                  const textRendering = renderPayloadText(payload)
                  return textRendering ? { textRendering } : {}
                })(),
                note: OUT_APP_LINK_NOTE,
              }
            : {}
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
                  ...outAppExtrasFor(activeViewId),
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

        // Rung 3 — interactive but out-app with no explicit page ask:
        // the answer belongs in THIS chat. Mirrors renderView; see
        // VIEW_MOUNT_CHANNELS.
        if (outApp && input.createPage !== true) {
          deps.onEvent?.({
            type: 'chart_rendered',
            viewId: '',
            entity: binding.entity,
            chartKind: input.kind,
          }, eventCtx(context))
          const textRendering = renderPayloadText(payload)
          return {
            data: {
              kind: 'view_payload' as const,
              payload,
              entity: binding.entity,
              viewType: 'chart',
              chartKind: input.kind,
              ...(textRendering ? { textRendering } : {}),
              note:
                'No page was created. This chat cannot display charts. Present the numbers in your reply using textRendering. Only if the user explicitly asks for a page they can open later, call renderChart again with createPage: true.',
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
            ...(viewId ? outAppExtrasFor(viewId) : {}),
          },
        }
      } catch (err) {
        return toolFailure(err, {
          tool: 'renderChart',
          target: 'the requested chart binding',
          next: 'No chart was rendered and no page was created.',
        })
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
        return bindingRejection({
          tool: 'saveView',
          effect: `the view "${input.name}" was NOT saved`,
          errors: formatBindingError(parsed.error, input.binding),
          guidance: VALID_BINDINGS,
        })
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
            // Absolute when boot wired `pageUrl` — out-app a relative path
            // is not clickable, and the reply must link the saved page.
            url:
              deps.pageUrl?.(created.workspaceId, created.id) ??
              `/w/${created.workspaceId}/p/${created.id}`,
          },
        }
      } catch (err) {
        return toolFailure(err, {
          tool: 'saveView',
          target: `view "${input.name}"`,
          mutating: true,
        })
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
