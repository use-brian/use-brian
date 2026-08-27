// [COMP:api/blueprint-record-tools] — the direct (in-context) surface of the
// blueprint output contract: save / read records without a synthesis run,
// define a new contract from chat, and discover what contracts exist.
//
// These are BRAIN BASE TOOLS (like `fillBlueprintFromBrain`): built at boot
// with deps and injected into BOTH the chat route and the callee executor —
// never connector tools, never in OFFICIAL_CONNECTOR_TOOLS, never through
// `mcp/inject.ts`. The callee-path parity is load-bearing: a record saved by a
// workflow step must use the exact tool chat uses ("works in chat, missing in
// workflow" is a documented footgun class).
//
// Billing: `saveBlueprintRecord` / `getBlueprintRecord` / `listBlueprints` are
// plain row reads/writes riding the turn — no model run, no surcharge (this is
// the cheap path `fillBlueprintFromBrain` is NOT). `createBlueprint` mints a
// `workspace_page_templates` row (requiresConfirmation — it creates a durable,
// workspace-visible object).
//
// See docs/architecture/brain/structural-synthesis.md → "The record" and
// docs/architecture/brain/structural-synthesis.md §6.

import { randomUUID } from 'node:crypto'

import { z } from 'zod'
import {
  buildTool,
  blueprintRecordToBlocks,
  extractionSpecSchema,
  extractionSpecToBlocks,
  fieldKeyFromHeading,
  markdownToBlocks,
  notFoundFailure,
  recordCompleteness,
  resolveWriteScope,
  scopeEvidenceFromRows,
  toolFailure,
  validateFieldValue,
  BLUEPRINT_CAPTURE_KINDS,
  ENTITY_REF_KINDS,
  EXTRACTION_FIELD_TYPES,
  type BlueprintRecordFields,
  type CustomPageTemplateSummary,
  type DocPageStore,
  type ExtractionSpec,
  type Tool,
} from '@use-brian/core'
import type { SavedViewStore } from '@use-brian/core'
import type { PageTemplateStore } from '../db/page-templates-store.js'
import type { BlueprintRecord, BlueprintRecordStore } from '../db/blueprint-records-store.js'
import { createRecordPageProjector } from './synthesize.js'

/**
 * Stable per-(workspace, blueprint, subject) record/page anchor. SAME literal
 * format the generate synthesizer has always used, so direct saves, generate
 * fills, and maintain refreshes for one subject all converge on ONE record and
 * ONE page instead of forking per surface.
 */
export function blueprintSubjectAnchorKey(
  workspaceId: string,
  blueprintId: string,
  subject: string,
): string {
  const subjectKey = subject.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 80)
  return `generate-synthesis:${workspaceId}:${blueprintId}:${subjectKey}`
}

/**
 * The slice of the saved-views store `projectBlueprintRecordPage` needs to
 * find-or-create the projection page on the record's anchor key — the exact
 * store methods, so the real `SavedViewStore` is assignable as-is.
 */
export type ProjectionViewStore = Pick<SavedViewStore, 'createDraft' | 'findIdByAnchorKey'>

export type BlueprintRecordToolDeps = {
  pageTemplateStore: PageTemplateStore
  blueprintRecordStore: BlueprintRecordStore
  /**
   * Page-projection deps. Both present → `projectBlueprintRecordPage` is
   * built; absent → the four record tools ship without it (schema-honest:
   * the tool simply doesn't exist where pages can't be projected).
   */
  savedViewStore?: ProjectionViewStore
  docPageStore?: Pick<DocPageStore, 'getVersionedPage' | 'applyPatch'>
}

/** Blueprints = templates carrying an extraction contract, id/name-resolvable. */
async function listWorkspaceBlueprints(
  deps: BlueprintRecordToolDeps,
  userId: string,
  workspaceId: string,
): Promise<CustomPageTemplateSummary[]> {
  const templates = await deps.pageTemplateStore.list(userId, workspaceId)
  return templates.filter((t) => t.extraction != null)
}

function resolveBlueprint(
  blueprints: CustomPageTemplateSummary[],
  needleRaw: string,
): CustomPageTemplateSummary | null {
  const needle = needleRaw.trim().toLowerCase()
  return (
    blueprints.find((t) => t.id === needleRaw) ??
    blueprints.find((t) => t.name.trim().toLowerCase() === needle) ??
    blueprints.find((t) => t.name.trim().toLowerCase().includes(needle)) ??
    null
  )
}

/**
 * Message-first failure copy for the blueprint surface
 * (docs/architecture/engine/tool-executor.md → "Failure copy").
 *
 * Every rejection here used to be `{ error: "<one clause>" }` — `No record
 * <id>.`, `No blueprint matching "x".`, `Rejected: …` — which said WHAT was
 * wrong and nothing else: not whether anything was written, not which call
 * resolves a real id, not whether the identical retry could ever work. The
 * helpers below carry all four, and every site returns TEXT rather than an
 * object so the model never parses JSON to read a sentence.
 */
function noWorkspace(tool: string, subject: string): { data: string; isError: true } {
  return {
    data:
      `${tool} did not run: this session is not bound to a workspace, and ${subject} are workspace-scoped — ` +
      'outside a workspace there is no library to read or write. ' +
      'This surface is reachable from a workspace chat, or from a workflow step whose assistant is bound to one. ' +
      'Ask the user to run it there. Retrying in this session will fail identically.',
    isError: true,
  }
}

/**
 * The blueprint resolver misses (`getBlueprintRecord`, `saveBlueprintRecord`,
 * `projectBlueprintRecordPage`, `fillBlueprintFromBrain`). Ships the list of
 * blueprints that DO exist — the discovery pointer that ends the guessing —
 * and says plainly when the workspace has none.
 */
function blueprintNotFound(params: {
  tool: string
  /** What did not happen, e.g. `read a record`, `save the record`. */
  effect: string
  needle: string
  blueprints: CustomPageTemplateSummary[]
  /** Set on the write paths so the model never reports a save that did not happen. */
  mutating?: boolean
}): { data: string; isError: true } {
  const names = params.blueprints.map((t) => t.name)
  const shown = names.slice(0, 8).join(', ')
  const more = names.length > 8 ? `, …and ${names.length - 8} more` : ''
  return {
    data:
      `${params.tool} could not ${params.effect}: no blueprint in this workspace matches "${params.needle}" ` +
      '— a blueprint is a page template carrying an extraction contract, and resolution is exact id, then exact ' +
      'name, then a name substring.' +
      (params.mutating ? ' Nothing was saved.' : '') +
      (names.length > 0
        ? ` Blueprints in this workspace right now: ${shown}${more}. Pass one of those names (or its id) exactly; listBlueprints returns each one's field contract.`
        : ' This workspace has no blueprints yet, so no name will resolve — define one with createBlueprint (ask the user first) or record the work another way.') +
      ' Do NOT retry this exact name.',
    isError: true,
  }
}

function recordSummary(record: BlueprintRecord): Record<string, unknown> {
  return {
    recordId: record.id,
    blueprintId: record.blueprintId,
    subject: record.subject,
    status: record.status,
    missing: record.missing,
    fields: record.fields,
    pageId: record.pageId,
    updatedAt: record.updatedAt,
  }
}

export function createBlueprintRecordTools(deps: BlueprintRecordToolDeps): Tool[] {
  const listBlueprints = buildTool({
    name: 'listBlueprints',
    description:
      'List this workspace\'s blueprints — the typed output contracts work can be saved under. ' +
      'Returns each blueprint\'s id, name, and field contract (key, type, required). ' +
      'Use before saving or reading blueprint records when unsure what exists.',
    inputSchema: z.object({}),
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(_input, context) {
      if (!context.workspaceId) {
        return noWorkspace('listBlueprints', 'blueprints')
      }
      const blueprints = await listWorkspaceBlueprints(deps, context.userId, context.workspaceId)
      return {
        data: {
          blueprints: blueprints.map((b) => ({
            id: b.id,
            name: b.name,
            description: b.description,
            fields: b.extraction?.fields.map((f) => ({
              key: f.key,
              type: f.type,
              required: f.required,
              heading: f.heading,
            })),
            capture: b.extraction?.capture ?? [],
          })),
        },
      }
    },
  })

  const getBlueprintRecord = buildTool({
    name: 'getBlueprintRecord',
    description:
      'Read a saved blueprint record — the typed output of prior work (a workflow run, a fill, a direct save). ' +
      'Pass the blueprint (name or id) plus the subject it is about, or a recordId directly. ' +
      'Returns the typed fields with status: "complete" means every required field is present — check it before relying on the values for a handoff.',
    inputSchema: z.object({
      blueprint: z.string().min(1).optional().describe('The blueprint name or id (omit when passing recordId).'),
      subject: z.string().min(1).optional().describe('What the record is about. Omitted → the blueprint\'s most recent record.'),
      recordId: z.string().min(1).optional().describe('Read one specific record by id.'),
    }),
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(input, context) {
      if (!context.workspaceId) {
        return noWorkspace('getBlueprintRecord', 'blueprint records')
      }
      if (input.recordId) {
        const rec = await deps.blueprintRecordStore.getById(context.userId, input.recordId)
        if (!rec || rec.workspaceId !== context.workspaceId) {
          return notFoundFailure({
            kind: 'Blueprint record',
            id: `\`${input.recordId}\``,
            discoveryTool: 'getBlueprintRecord with `blueprint` (name or id) + `subject`, or listBlueprints first',
            extra: 'A record that belongs to another workspace reads as missing here.',
            idSource: 'a saveBlueprintRecord, getBlueprintRecord or fillBlueprintFromBrain result',
          })
        }
        return { data: recordSummary(rec), scopeEvidence: scopeEvidenceFromRows([rec]) }
      }
      if (!input.blueprint) {
        return {
          data:
            'getBlueprintRecord did not run: the call carried neither `recordId` nor `blueprint`, and a record can ' +
            'only be addressed one of those two ways. Nothing was read. Pass `recordId` for one specific record, or ' +
            '`blueprint` (name or id) plus an optional `subject` for the latest record under that contract; ' +
            'listBlueprints shows which blueprints exist. The same empty call will fail identically.',
          isError: true,
        }
      }
      const blueprints = await listWorkspaceBlueprints(deps, context.userId, context.workspaceId)
      const match = resolveBlueprint(blueprints, input.blueprint)
      if (!match) {
        return blueprintNotFound({
          tool: 'getBlueprintRecord',
          effect: 'read a record',
          needle: input.blueprint,
          blueprints,
        })
      }
      const rec = input.subject
        ? await deps.blueprintRecordStore.getLatestBySubject(
            context.userId,
            context.workspaceId,
            match.id,
            input.subject.trim(),
          )
        : ((await deps.blueprintRecordStore.listForBlueprint(context.userId, context.workspaceId, match.id, 1))[0] ??
          null)
      if (!rec) {
        return {
          data: input.subject
            ? `getBlueprintRecord found no "${match.name}" record for subject "${input.subject}" in this workspace. ` +
              'The blueprint exists; nothing has been saved under that subject yet. Subjects match on the exact ' +
              'trimmed string, so a differently-worded subject is a different record. ' +
              'Call getBlueprintRecord again without `subject` to see this blueprint\'s most recent record, or ' +
              'produce one with saveBlueprintRecord / fillBlueprintFromBrain. Do NOT retry this exact subject.'
            : `getBlueprintRecord found no "${match.name}" records at all in this workspace. The blueprint exists, ` +
              'but nothing has ever been saved under it. Save work under it with saveBlueprintRecord, or synthesize ' +
              'one from the brain with fillBlueprintFromBrain, before reading. Retrying this read will keep coming ' +
              'back empty.',
          isError: true,
        }
      }
      return {
        data: { blueprint: match.name, ...recordSummary(rec) },
        scopeEvidence: scopeEvidenceFromRows([rec]),
      }
    },
  })

  const saveBlueprintRecord = buildTool({
    name: 'saveBlueprintRecord',
    description:
      'Persist work you already produced as a typed blueprint record in the brain — the durable, structured output other workflows and assistants read. ' +
      'Pass the blueprint (name or id), the subject the work is about, and `fields` keyed EXACTLY by the blueprint\'s field keys (listBlueprints shows them). ' +
      'Values are validated per field type; invalid keys or values are rejected. Saving the same (blueprint, subject) again merges over the existing record. ' +
      'Use when a skill/workflow bound a blueprint to the job, or after the user agrees to save matching work — do not save unrequested work silently.',
    inputSchema: z.object({
      blueprint: z.string().min(1).describe('The blueprint name or id.'),
      subject: z.string().min(1).max(512).describe('What this record is about (an account, deal, topic).'),
      fields: z
        .record(z.any())
        .describe('The field values, keyed by the blueprint\'s field keys. Shapes: markdown/string → text; number → number; date → "YYYY-MM-DD"; boolean → true/false; enum → an allowed option; entityRef → { "name": "..." }.'),
    }),
    async execute(input, context) {
      if (!context.workspaceId) {
        return noWorkspace('saveBlueprintRecord', 'blueprint records')
      }
      const blueprints = await listWorkspaceBlueprints(deps, context.userId, context.workspaceId)
      const match = resolveBlueprint(blueprints, input.blueprint)
      if (!match?.extraction) {
        return blueprintNotFound({
          tool: 'saveBlueprintRecord',
          effect: 'save the record',
          needle: input.blueprint,
          blueprints,
          mutating: true,
        })
      }
      const spec = match.extraction

      // Validate every provided key against the contract BEFORE writing.
      const validated: BlueprintRecordFields = {}
      const errors: string[] = []
      for (const [key, raw] of Object.entries(input.fields as Record<string, unknown>)) {
        const field = spec.fields.find((f) => f.key === key)
        if (!field) {
          errors.push(`unknown field "${key}" (valid: ${spec.fields.map((f) => f.key).join(', ')})`)
          continue
        }
        const result = validateFieldValue(field, raw)
        if (!result.ok) {
          errors.push(result.error)
          continue
        }
        validated[key] = result.value
      }
      if (errors.length > 0) {
        return {
          data:
            `saveBlueprintRecord did not save the "${match.name}" record for "${input.subject.trim()}": ` +
            `${errors.length} field value(s) failed the blueprint's contract, and a record is written whole or not ` +
            'at all. Nothing was saved.\nRejected:\n' +
            errors.map((e) => `  - ${e}`).join('\n') +
            `\nField keys on this blueprint: ${spec.fields.map((f) => `${f.key} (${f.type}${f.required ? ', required' : ''})`).join(', ')}.` +
            '\nCorrect those values and call again. Re-sending the same values will be rejected the same way.',
          isError: true,
        }
      }
      if (Object.keys(validated).length === 0) {
        return {
          data:
            `saveBlueprintRecord did not save a "${match.name}" record: \`fields\` was empty, so there was nothing ` +
            'to write. Nothing was saved. Pass at least one value keyed by this blueprint\'s field keys ' +
            `(${spec.fields.map((f) => f.key).join(', ')}). An empty \`fields\` is always rejected.`,
          isError: true,
        }
      }

      const subject = input.subject.trim()
      const writeScope = resolveWriteScope({
        sensitivity: 'internal',
        baseCompartments: context.assistantDefaultCompartments,
        baseProjectIds: context.assistantDefaultProjectIds,
        evidence: context.scopeAccumulator,
        compartmentGrant: context.assistantCompartments,
        projectGrant: context.assistantProjectIds,
      })
      // Direct saves MERGE (resetFields:false): a partial save must not wipe
      // fields a prior fill grounded. Same anchor as a generate fill for this
      // (blueprint, subject) — one record per subject across surfaces.
      const ensured = await deps.blueprintRecordStore.ensure(context.userId, {
        workspaceId: context.workspaceId,
        blueprintId: match.id,
        specSnapshot: spec.fields,
        subject,
        anchorKey: blueprintSubjectAnchorKey(context.workspaceId, match.id, subject),
        // Workflow-origin saves stamp the RUN id (threaded via
        // ToolContext.workflowRunId) — the provenance `{{lastRun.output.*}}`
        // joins on. Callee turns without a run id still mark 'workflow';
        // anything else is an interactive chat surface.
        sourceKind:
          context.workflowRunId ||
          context.channelType === 'assistant-call' ||
          context.channelType === 'workflow'
            ? 'workflow'
            : 'chat',
        sourceId: context.workflowRunId ?? context.sessionId ?? null,
        sensitivity: writeScope.sensitivity,
        compartments: writeScope.compartments,
        projectIds: writeScope.projectIds,
        resetFields: false,
      })
      await deps.blueprintRecordStore.mergeFields(context.userId, ensured.id, validated)
      const merged = { ...ensured.fields, ...validated }
      const completeness = recordCompleteness(spec.fields, merged)
      const finalized = await deps.blueprintRecordStore.finalize(context.userId, ensured.id, {
        status: completeness.status,
        missing: completeness.missing,
      })
      return {
        data: {
          saved: true,
          blueprint: match.name,
          ...recordSummary(finalized ?? { ...ensured, fields: merged, ...completeness }),
        },
      }
    },
  })

  const createBlueprint = buildTool({
    name: 'createBlueprint',
    description:
      'Define a NEW blueprint — a reusable typed output contract for this workspace. ' +
      'Pass a name and the fields (heading + instruction + type; mark handoff-critical ones required). ' +
      `Types: ${EXTRACTION_FIELD_TYPES.join(', ')}. Enum fields need options; entityRef fields need entityKind (${ENTITY_REF_KINDS.join(', ')}). ` +
      'The blueprint appears in Brain → Blueprints (with an editable page skeleton) and can then be filled from a recording, the brain, research, or saved directly with saveBlueprintRecord. ' +
      'Use when the user wants a repeatable output shape — not for one-off notes.',
    inputSchema: z.object({
      name: z.string().min(1).max(256).describe('Display name (e.g. "Discovery Brief").'),
      description: z.string().max(2000).optional().describe('One line on when to use it.'),
      fields: z
        .array(
          z.object({
            key: z
              .string()
              .min(1)
              .max(64)
              .regex(/^[a-z0-9][a-z0-9_-]*$/)
              .optional()
              .describe('Stable slug; derived from the heading when omitted.'),
            heading: z.string().min(1).max(200),
            instruction: z.string().min(1).max(2000).describe('How to fill this field from a source.'),
            type: z.enum(EXTRACTION_FIELD_TYPES).optional().describe('Default markdown.'),
            options: z.array(z.string().min(1).max(120)).min(2).max(24).optional(),
            entityKind: z.enum(ENTITY_REF_KINDS).optional(),
            required: z.boolean().optional(),
          }),
        )
        .min(1)
        .max(30),
      capture: z
        .array(z.enum(BLUEPRINT_CAPTURE_KINDS))
        .optional()
        .describe('Brain primitives a fill should also capture (company, contact, deal, task, memory).'),
      captureInstructions: z
        .record(z.string(), z.string().max(2000))
        .optional()
        .describe(
          'Optional per-kind guidance keyed by a capture kind — HOW to write that kind from the source (e.g. {"task": "one task per maintenance item, imperative title"}). Only kinds listed in `capture` are used.',
        ),
    }),
    requiresConfirmation: true,
    async execute(input, context) {
      if (!context.workspaceId) {
        return noWorkspace('createBlueprint', 'blueprints')
      }
      // Auto-key omitted keys from headings, then validate the whole contract
      // through the SAME schema the store/editor use — one validation surface.
      const taken = new Set<string>(input.fields.map((f) => f.key).filter((k): k is string => !!k))
      const rawSpec = {
        fields: input.fields.map((f) => ({
          ...f,
          key: f.key ?? fieldKeyFromHeading(f.heading, taken),
          type: f.type ?? 'markdown',
        })),
        capture: input.capture ?? [],
        ...(input.captureInstructions ? { captureInstructions: input.captureInstructions } : {}),
      }
      const parsed = extractionSpecSchema.safeParse(rawSpec)
      if (!parsed.success) {
        const issues = parsed.error.issues.slice(0, 8).map((i) => {
          const path = i.path.length > 0 ? i.path.join('.') : '<contract>'
          return `  - ${path}: ${i.message}`
        })
        const more = parsed.error.issues.length > 8 ? `\n  …and ${parsed.error.issues.length - 8} more` : ''
        return {
          data:
            `createBlueprint did not create "${input.name.trim()}": the field contract failed validation, so no ` +
            'blueprint was created.\nRejected:\n' +
            issues.join('\n') +
            more +
            `\nField types: ${EXTRACTION_FIELD_TYPES.join(', ')}. An enum field also needs \`options\`; an ` +
            `entityRef field also needs \`entityKind\` (${ENTITY_REF_KINDS.join(', ')}).` +
            '\nFix the named field(s) and call again. The same contract will be rejected the same way.',
          isError: true,
        }
      }
      const spec: ExtractionSpec = parsed.data
      try {
        const created = await deps.pageTemplateStore.create(context.userId, {
          workspaceId: context.workspaceId,
          name: input.name.trim(),
          description: input.description?.trim() || null,
          icon: null,
          category: 'knowledge',
          blocks: extractionSpecToBlocks(spec),
          extraction: spec,
        })
        return {
          data: {
            blueprintId: created.id,
            name: created.name,
            fields: spec.fields.map((f) => ({ key: f.key, type: f.type, required: f.required })),
          },
        }
      } catch (err) {
        return toolFailure(err, {
          tool: 'createBlueprint',
          action: 'createBlueprint',
          target: `the blueprint "${input.name.trim()}"`,
          mutating: true,
          next: 'A name that collides with an existing blueprint is the common cause — call listBlueprints and pick a distinct one.',
        })
      }
    },
  })

  const tools = [listBlueprints, getBlueprintRecord, saveBlueprintRecord, createBlueprint]

  // ── projectBlueprintRecordPage — record → linked page (+ draft body) ──
  // The one workflow-reachable path that produces `blueprint_records.page_id`
  // linkage (synthesis is engine-side; the REST projection route is not a
  // tool). Without this, blueprint-scoped page-action buttons never resolve
  // on generator-made pages. With `draftMarkdown` the page body becomes the
  // draft VERBATIM (no record-field scaffolding) — that page is exactly what
  // `send_page` emails, so the record fields must never leak into it.
  // See docs/architecture/features/page-actions.md → "Record→page projection".
  const { savedViewStore, docPageStore } = deps
  if (savedViewStore && docPageStore) {
    const projectPage = createRecordPageProjector(docPageStore)
    tools.push(
      buildTool({
        name: 'projectBlueprintRecordPage',
        description:
          'Create (or refresh) the doc page linked to a blueprint record. Resolve the record by recordId, or by blueprint (name or id) + subject. ' +
          'With `draftMarkdown`, the page body becomes exactly that markdown — use for review-then-send drafts where the page IS the outgoing message. ' +
          'Without it, the page renders the record\'s field projection. Idempotent per record: the same record always converges on one page. ' +
          'Returns the pageId. Optionally nest the page under `parentPageId`.',
        inputSchema: z.object({
          recordId: z.string().uuid().optional().describe('The record id (from saveBlueprintRecord / getBlueprintRecord).'),
          blueprint: z.string().min(1).optional().describe('Blueprint name or id — used with `subject` when recordId is absent.'),
          subject: z.string().min(1).max(512).optional().describe('The record subject — used with `blueprint`.'),
          parentPageId: z.string().uuid().optional().describe('Nest the created page under this page.'),
          title: z.string().min(1).max(256).optional().describe('Page title; defaults to the record subject.'),
          draftMarkdown: z
            .string()
            .min(1)
            .max(40_000)
            .optional()
            .describe('When set, the page body is exactly this markdown (a review-then-send draft), not the record projection.'),
        }),
        async execute(input, context) {
          if (!context.workspaceId) {
            return noWorkspace('projectBlueprintRecordPage', 'blueprint records and pages')
          }
          // Resolve the record.
          let record: BlueprintRecord | null = null
          if (input.recordId) {
            record = await deps.blueprintRecordStore.getById(context.userId, input.recordId)
            if (record && record.workspaceId !== context.workspaceId) record = null
          } else if (input.blueprint && input.subject) {
            const blueprints = await listWorkspaceBlueprints(deps, context.userId, context.workspaceId)
            const match = resolveBlueprint(blueprints, input.blueprint)
            if (!match) {
              return blueprintNotFound({
                tool: 'projectBlueprintRecordPage',
                effect: 'resolve the record to project',
                needle: input.blueprint,
                blueprints,
                mutating: true,
              })
            }
            record = await deps.blueprintRecordStore.getLatestBySubject(
              context.userId,
              context.workspaceId,
              match.id,
              input.subject.trim(),
            )
          } else {
            return {
              data:
                'projectBlueprintRecordPage did not run: the call named no record. No page was created or changed. ' +
                'Pass `recordId`, or `blueprint` (name or id) together with `subject` — `blueprint` alone does not ' +
                'identify a record. The same call will fail identically.',
              isError: true,
            }
          }
          if (!record) {
            const target = input.recordId
              ? `recordId \`${input.recordId}\``
              : `blueprint "${input.blueprint}" + subject "${input.subject}"`
            return {
              data:
                `projectBlueprintRecordPage found no blueprint record for ${target} in this workspace. ` +
                'No page was created or changed. A page is a projection OF a record, so the record has to exist ' +
                'first: save it with saveBlueprintRecord (or synthesize it with fillBlueprintFromBrain), then ' +
                'project that record. Do NOT retry this exact target.',
              isError: true,
            }
          }

          // Find-or-create the page on the record's own anchor key (the same
          // 23505-converge identity the REST projection route uses).
          let pageId = record.pageId
          if (!pageId) {
            pageId = await savedViewStore.findIdByAnchorKey(
              context.userId,
              context.workspaceId,
              record.anchorKey,
            )
          }
          if (!pageId) {
            try {
              const draft = await savedViewStore.createDraft({
                userId: context.userId,
                workspaceId: context.workspaceId,
                name: input.title ?? record.subject,
                nameOrigin: input.title ? 'user' : 'placeholder',
                entity: 'tasks',
                viewType: 'table',
                binding: { entity: 'tasks', viewType: 'table' },
                page: { blocks: [] },
                anchorKey: record.anchorKey,
                originPrompt: `blueprint record: ${record.subject}`,
                nestParentId: input.parentPageId ?? null,
                // Born saved — same durability contract as the recording /
                // generate briefs (structural-synthesis.md → "Brief
                // durability"). A projected record page is a deliberate
                // artifact; the 30-day draft TTL would delete it silently.
                state: 'saved',
                writtenBy: 'system',
              })
              pageId = draft.id
            } catch {
              pageId = await savedViewStore.findIdByAnchorKey(
                context.userId,
                context.workspaceId,
                record.anchorKey,
              )
            }
          }
          if (!pageId) {
            return {
              data:
                `projectBlueprintRecordPage could not create the page for record ${record.id} ` +
                `("${record.subject}"): the page create failed and no page exists on that record's anchor key. ` +
                'Nothing was projected; the record itself is intact and still holds the data. ' +
                'This is a write failure rather than anything wrong with the arguments — retry once, and if it ' +
                'fails again tell the user instead of looping.',
              isError: true,
            }
          }

          const blocks = input.draftMarkdown
            ? markdownToBlocks(input.draftMarkdown, { genId: () => randomUUID() })
            : blueprintRecordToBlocks(record.specSnapshot, record.fields, () => randomUUID())
          const projected = await projectPage({ userId: context.userId, pageId, blocks })
          if (!projected) {
            return {
              data:
                `projectBlueprintRecordPage did not write the projection for record ${record.id} ` +
                `("${record.subject}"): page ${pageId} is being edited concurrently and its version moved under the ` +
                'write twice in a row, so the projection was skipped rather than overwriting somebody\'s edit. ' +
                'Nothing was projected; the record still holds the data and the next projection re-renders it. ' +
                'Retry once in a moment; if it keeps conflicting, tell the user that page is open for editing.',
              isError: true,
            }
          }
          await deps.blueprintRecordStore.finalize(context.userId, record.id, {
            status: record.status,
            missing: record.missing,
            pageId,
          })
          return {
            data: {
              projected: true,
              pageId,
              recordId: record.id,
              subject: record.subject,
              body: input.draftMarkdown ? 'draft' : 'record-projection',
            },
          }
        },
      }),
    )
  }

  return tools
}

/**
 * The dynamic "workspace blueprints" prompt section — present ONLY when the
 * workspace has at least one blueprint, and naming ONLY blueprints that exist
 * right now (closed-world; Layer 1 stays tool-agnostic — this is a dynamic
 * injection, the same discipline as the unavailable-capabilities block).
 * Carries the LOCKED application posture: auto-save when bound, propose when
 * unbound, never silent.
 */
export function buildBlueprintSurfacePrompt(blueprints: CustomPageTemplateSummary[]): string {
  const withSpec = blueprints.filter((b) => b.extraction != null).slice(0, 12)
  if (withSpec.length === 0) return ''
  const lines = withSpec.map((b) => {
    const keys = (b.extraction?.fields ?? [])
      .map((f) => `${f.key}${f.required ? '*' : ''}`)
      .join(', ')
    return `- "${b.name}" — fields: ${keys}${b.description ? ` — ${b.description}` : ''}`
  })
  return [
    '',
    '## Workspace blueprints (typed output contracts)',
    'This workspace defines blueprints — contracts for how finished work persists in the brain as typed RECORDS other workflows and teammates rely on. Records are the durable output; pages are optional visualizations.',
    '- When the current job was bound to a blueprint (a skill directive, a workflow step, or the user named one), save the finished work with `saveBlueprintRecord` as part of completing the job.',
    '- When finished work merely MATCHES one of the blueprints below, offer to save it as a record first — never save unbound work silently.',
    '- Read prior records with `getBlueprintRecord` (check `status === "complete"` before relying on values). Synthesize a record from what the brain holds with `fillBlueprintFromBrain`. Define a new contract with `createBlueprint` only when the user wants a repeatable output shape.',
    'Blueprints available right now (* = required field):',
    ...lines,
    '',
  ].join('\n')
}
