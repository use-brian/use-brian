/**
 * Confirmed assistant tools for existing Brain Review entries.
 *
 * `findEditableBrainEntries` is bounded and read-only. `updateBrainEntry`
 * carries the exact row revision returned by discovery/open-entry context and
 * pauses on the standard confirmation lane before crossing BrainEntryMutator.
 *
 * Spec: docs/architecture/brain/corrections.md -> "Conversational entry editing".
 * [COMP:api/brain-entry-edit]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '@use-brian/core'
import {
  EDITABLE_FIELDS_BY_PRIMITIVE,
  type BrainEntryMutator,
  type EditableBrainEntry,
  type EditableBrainPrimitive,
} from './brain-entry-mutation.js'

const primitiveSchema = z.enum([
  'memory',
  'entity',
  'task',
  'contact',
  'company',
  'deal',
  'workspace_file',
])

const updateInputSchema = z
  .strictObject({
    primitive: primitiveSchema.describe(
      'Primitive returned by findEditableBrainEntries or the currently-viewing entry context.',
    ),
    rowId: z.string().uuid().describe(
      'Exact row id returned by discovery or the currently-viewing entry context.',
    ),
    expectedUpdatedAt: z.string().datetime().describe(
      'Exact updated-at revision returned with the row. Never invent or omit it.',
    ),
    summary: z.string().trim().min(1).max(500).optional(),
    detail: z.string().max(50_000).optional(),
    scope: z.enum(['personal', 'workspace_shared', 'workspace']).optional(),
    sensitivity: z.enum(['public', 'internal', 'confidential']).optional(),
    display_name: z.string().trim().min(1).max(200).optional(),
    title: z.string().trim().min(1).max(500).optional(),
    status: z.enum([
      'todo',
      'in_progress',
      'in_review',
      'blocked',
      'done',
      'archived',
    ]).optional(),
    due_at: z.string().datetime().nullable().optional(),
    tags: z.array(z.string().trim().min(1)).max(50).optional(),
    assignee_id: z.string().min(1).nullable().optional(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).nullable().optional(),
    description: z.string().max(10_000).nullable().optional(),
    icon: z.string().min(1).max(32).nullable().optional(),
    email: z.string().trim().min(1).max(320).nullable().optional(),
    phone: z.string().trim().min(1).max(64).nullable().optional(),
    company_id: z.string().uuid().nullable().optional(),
    domain: z.string().trim().min(1).max(256).nullable().optional(),
    stage: z.enum([
      'lead',
      'qualified',
      'proposal',
      'negotiation',
      'won',
      'lost',
    ]).optional(),
    amount: z.number().nonnegative().nullable().optional(),
    close_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .superRefine((input, ctx) => {
    const meta = new Set(['primitive', 'rowId', 'expectedUpdatedAt', 'reason'])
    const changed = Object.keys(input).filter(
      (key) => !meta.has(key) && input[key as keyof typeof input] !== undefined,
    )
    if (changed.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide at least one editable field.',
      })
      return
    }
    const allowed = new Set(EDITABLE_FIELDS_BY_PRIMITIVE[input.primitive])
    const invalid = changed.find((key) => !allowed.has(key))
    if (invalid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [invalid],
        message: `${invalid} is not editable for ${input.primitive}. Allowed fields: ${[...allowed].join(', ')}`,
      })
    }
  })

export type BrainEntryUpdateInput = z.infer<typeof updateInputSchema>

export type BrainEntryEditTools = {
  findEditableBrainEntries: Tool
  updateBrainEntry: Tool
}

function revision(entry: EditableBrainEntry): string {
  return entry.updatedAt.toISOString()
}

function compact(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(empty)'
  const rendered = Array.isArray(value)
    ? value.join(', ')
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value)
  return rendered.length > 900 ? `${rendered.slice(0, 900)}…` : rendered
}

function beforeValue(entry: EditableBrainEntry, field: string): unknown {
  const body = entry.body
  if (field === 'display_name') return body.display_name ?? body.name
  if (field === 'due_at') return body.due_at ?? body.due
  if (field === 'assignee_id') return body.assignee_id
  if (field === 'priority' || field === 'description' || field === 'icon') {
    const attributes = body.attributes
    return attributes && typeof attributes === 'object' && !Array.isArray(attributes)
      ? (attributes as Record<string, unknown>)[field]
      : undefined
  }
  return body[field]
}

function changedFields(input: BrainEntryUpdateInput): Array<[string, unknown]> {
  const meta = new Set(['primitive', 'rowId', 'expectedUpdatedAt', 'reason'])
  return Object.entries(input).filter(
    ([key, value]) => !meta.has(key) && value !== undefined,
  )
}

export function parseBrainEditChannelId(
  channelId: string,
): { primitive: EditableBrainPrimitive; rowId: string } | null {
  const [primitive, rowId] = channelId.split(':', 3)
  if (!(primitive in EDITABLE_FIELDS_BY_PRIMITIVE) || !rowId) return null
  return { primitive: primitive as EditableBrainPrimitive, rowId }
}

export function buildViewingBrainEntryBlock(entry: EditableBrainEntry): string {
  const body = JSON.stringify(entry.body, null, 2)
  const capped = body.length > 12_000 ? `${body.slice(0, 12_000)}\n…(truncated)` : body
  return [
    '# Currently viewing: Brain entry',
    'The user has this exact Brain entry open. References such as "this entry", "this item", or the visible title refer to it.',
    `Entry: ${JSON.stringify(entry.label)}`,
    `Primitive: ${entry.primitive}`,
    `Row id: ${entry.id}`,
    `Revision: ${revision(entry)}`,
    `Editable fields: ${entry.editableFields.join(', ')}`,
    '',
    'Current saved entry:',
    '```json',
    capped,
    '```',
    '',
    'For a requested change, use the scoped Brain-entry update capability with this exact primitive, row id, and revision. The user reviews the before/after proposal before any write. Do not create or edit a Document page for this entry request.',
  ].join('\n')
}

export function createBrainEntryEditTools(args: {
  mutator: BrainEntryMutator
  /** Present for an open-entry turn or a server-bound brain_edit session. */
  scopedEntry?: EditableBrainEntry | null
}): BrainEntryEditTools {
  // Unscoped main chat may update only a target returned by THIS turn's
  // server-side discovery. The model cannot mint arbitrary ids/revisions.
  // Row-bound edit/open-entry turns use `scopedEntry` instead.
  const discoveredTargets = new Map<string, string>()
  let discoveryWasAmbiguous = false
  const targetKey = (primitive: EditableBrainPrimitive, rowId: string) =>
    `${primitive}:${rowId}`

  const findEditableBrainEntries = buildTool({
    name: 'findEditableBrainEntries',
    description:
      'Find existing editable entries in the Brain Review queue by words from their title or content. Use this when the user asks to modify a Brain entry but no currently-viewing entry is supplied. Returns exact primitive, row id, revision, and editable fields. If zero or multiple plausible rows are returned, ask the user instead of guessing. This never creates or changes an entry.',
    inputSchema: z.object({
      query: z.string().trim().min(1).max(500),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(input, context) {
      if (!context.workspaceId) {
        return { data: 'Brain entry discovery requires workspace context.', isError: true }
      }
      const entries = await args.mutator.findEditableEntries(
        context.workspaceId,
        input.query,
        input.limit,
        { userId: context.userId, clearance: context.clearance },
      )
      discoveredTargets.clear()
      discoveryWasAmbiguous = entries.length > 1
      if (entries.length === 0) {
        return {
          data: {
            status: 'no_match',
            matches: [],
            instruction:
              'Do not create a replacement entry or Document page. Ask the user for another title or more detail.',
          },
        }
      }
      const matches = entries.map((entry) => {
        const entryRevision = revision(entry)
        discoveredTargets.set(
          targetKey(entry.primitive, entry.id),
          entryRevision,
        )
        return {
          primitive: entry.primitive,
          rowId: entry.id,
          revision: entryRevision,
          label: entry.label,
          editableFields: entry.editableFields,
        }
      })
      return {
        data: {
          status: matches.length === 1 ? 'single_match' : 'ambiguous',
          matches,
          ...(matches.length > 1
            ? {
                instruction:
                  'Ask the user to choose one match. Do not update any entry yet.',
              }
            : {}),
        },
      }
    },
  })

  const updateBrainEntry = buildTool<typeof updateInputSchema>({
    name: 'updateBrainEntry',
    description:
      `Propose and apply changes to an EXISTING Brain Review entry${args.scopedEntry ? ` currently open as ${JSON.stringify(args.scopedEntry.label)}` : ''}. ` +
      'Pass only fields the user asked to change. This always pauses for the user to review a server-built before/after preview. It never creates an entry, relationship, file body, or Document page. Use findEditableBrainEntries first when no open entry context identifies one exact target.',
    inputSchema: updateInputSchema,
    requiresConfirmation: true,
    isReadOnly: false,
    isConcurrencySafe: false,
    async describeConfirmation(rawInput, context) {
      const input = updateInputSchema.parse(rawInput)
      const discoveredRevision = discoveredTargets.get(
        targetKey(input.primitive, input.rowId),
      )
      if (
        !args.scopedEntry &&
        (discoveryWasAmbiguous || discoveredRevision !== input.expectedUpdatedAt)
      ) {
        return [
          discoveryWasAmbiguous
            ? 'Brain Review discovery returned multiple matches. Ask the user to choose one before proposing a change.'
            : 'This target was not returned by Brain Review discovery in this turn.',
          'No entry will be changed.',
        ]
      }
      const entry = await args.mutator.getEditableEntry(
        args.scopedEntry?.workspaceId ?? context.workspaceId ?? '',
        input.primitive,
        input.rowId,
        { userId: context.userId, clearance: context.clearance },
      )
      if (!entry) {
        return [
          'This Brain Review entry is no longer available.',
          'No entry will be changed.',
        ]
      }
      if (revision(entry) !== input.expectedUpdatedAt) {
        return [
          `Entry: ${entry.label}`,
          'This entry changed after the proposal was prepared.',
          'No entry will be changed until the proposal is regenerated.',
        ]
      }
      const visible = entry
      const lines = [
        `Entry: ${visible?.label ?? `${input.primitive} ${input.rowId.slice(0, 8)}`}`,
      ]
      for (const [field, value] of changedFields(input)) {
        lines.push(`@@ ${field}`)
        lines.push(`- ${compact(visible ? beforeValue(visible, field) : undefined)}`)
        lines.push(`+ ${compact(value)}`)
      }
      return lines
    },
    async execute(input, context) {
      if (!context.workspaceId) {
        return { data: 'Brain entry updates require workspace context.', isError: true }
      }
      const discoveredRevision = discoveredTargets.get(
        targetKey(input.primitive, input.rowId),
      )
      if (
        !args.scopedEntry &&
        (discoveryWasAmbiguous || discoveredRevision !== input.expectedUpdatedAt)
      ) {
        return {
          data: discoveryWasAmbiguous
            ? 'Brain Review discovery returned multiple matches. Ask the user to choose one before proposing a change. No entry was changed.'
            : 'The requested target was not returned by Brain Review discovery in this turn. No entry was changed.',
          isError: true,
        }
      }
      if (
        args.scopedEntry &&
        (input.primitive !== args.scopedEntry.primitive ||
          input.rowId !== args.scopedEntry.id ||
          input.expectedUpdatedAt !== revision(args.scopedEntry))
      ) {
        return {
          data: 'The requested target does not match the Brain entry open in this conversation.',
          isError: true,
        }
      }
      const { primitive, rowId, expectedUpdatedAt, ...rawChanges } = input
      const result = await args.mutator.mutate({
        userId: context.userId,
        workspaceId: context.workspaceId,
        primitive,
        rowId,
        expectedUpdatedAt,
        changes: rawChanges as Record<string, unknown>,
      })
      if (result.status < 200 || result.status >= 300) {
        return {
          data:
            typeof result.body.error === 'string'
              ? result.body.error
              : `Brain entry update failed (${result.status}).`,
          isError: true,
        }
      }
      const memory = result.body.memory
      const liveRowId =
        typeof result.body.id === 'string'
          ? result.body.id
          : memory && typeof memory === 'object' && typeof (memory as Record<string, unknown>).id === 'string'
            ? String((memory as Record<string, unknown>).id)
            : rowId
      return {
        data: {
          kind: 'brain_entry_updated',
          primitive,
          previousRowId: rowId,
          liveRowId,
          changedFields: changedFields(input).map(([field]) => field),
        },
      }
    },
  })

  return { findEditableBrainEntries, updateBrainEntry }
}
