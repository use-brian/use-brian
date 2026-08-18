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

/**
 * The one discovery pointer for this surface. `findEditableBrainEntries` is
 * the ONLY way to obtain a `(primitive, rowId, revision)` triple the update
 * path will accept when no entry is open — the model cannot mint one, and a
 * rowId remembered from an earlier turn is routinely dead (below).
 */
const BRAIN_DISCOVERY =
  'findEditableBrainEntries with words from the entry title or content'

/**
 * Why a rowId that looked right can miss: brain rows are BI-TEMPORAL. An edit
 * does not update in place, it supersedes the row and mints a NEW id (that is
 * why a successful update returns `previousRowId` AND `liveRowId`). So an id
 * carried over from an earlier turn points at a retired version, and a blind
 * retry with it can never succeed.
 */
const BRAIN_SUPERSESSION =
  'Brain rows are bi-temporal: any earlier edit SUPERSEDED that row and minted a new id (an update returns the new one as `liveRowId`), so an id remembered from a previous turn is already retired.'

/** Failure copy for a non-2xx from the mutator: what ran, why, next step, verdict. */
function mutationFailure(
  input: BrainEntryUpdateInput,
  result: { status: number; body: Record<string, unknown> },
): { data: string; isError: true } {
  const routeSaid =
    typeof result.body.error === 'string' && result.body.error.trim()
      ? ` The Brain entry API said: ${result.body.error.trim()}`
      : ''
  const fields = changedFields(input).map(([field]) => field)
  const what =
    `Updating ${fields.length ? fields.join(', ') : 'no fields'} on ${input.primitive} ${input.rowId} failed (HTTP ${result.status}).${routeSaid} ` +
    'Nothing was saved — the entry is exactly as it was.'

  if (result.status === 404) {
    return {
      data:
        `${what} No editable Brain entry answers to that primitive + rowId. ${BRAIN_SUPERSESSION} ` +
        `It may also have been deleted, or sit above this assistant's clearance. ` +
        `Call ${BRAIN_DISCOVERY} to re-resolve BOTH the current rowId and its revision, then re-issue with the pair from that result. Do NOT retry this exact rowId.`,
      isError: true,
    }
  }
  if (result.status === 409) {
    return {
      data:
        `${what} The entry was edited by someone else after this proposal was prepared, so the \`expectedUpdatedAt\` revision you sent is stale and the write was refused rather than silently overwriting their change. ` +
        `Call ${BRAIN_DISCOVERY} (or reopen the entry) to read the CURRENT revision, show the user what changed, and re-issue with the new revision. Retrying with revision ${input.expectedUpdatedAt} will keep failing.`,
      isError: true,
    }
  }
  if (result.status === 401 || result.status === 403) {
    return {
      data:
        `${what} This is an authorization refusal, not a bad argument: the speaker is not a member of the entry's workspace, or the entry's sensitivity is above this assistant's clearance. ` +
        'No wording of this call can get past it — tell the user which entry could not be edited and that access has to be granted in Studio. Do not retry.',
      isError: true,
    }
  }
  if (result.status >= 500) {
    return {
      data:
        `${what} That is a server-side failure, not a problem with the arguments. Retry this exact call once after a short wait; if it fails again, tell the user the Brain entry could not be saved rather than looping.`,
      isError: true,
    }
  }
  return {
    data:
      `${what} The request itself was rejected — fix the field the message above names (or drop it) and re-issue. ` +
      `Re-sending the same value will be rejected the same way; if the message names no field you can fix, ask the user what the value should be.`,
    isError: true,
  }
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
        return {
          data:
            'Brain entries live in a workspace and this conversation is not bound to one, so there was nothing to search and no entry was returned. ' +
            'Ask the user to open this assistant inside a workspace (or switch to a workspace-scoped chat) and repeat the request there. ' +
            'Re-running findEditableBrainEntries on this surface will fail the same way — do not fall back to creating a replacement entry or a Document page.',
          isError: true,
        }
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
        return {
          data:
            `Updating ${input.primitive} ${input.rowId} was refused: Brain entries live in a workspace and this conversation is not bound to one, so nothing was saved. ` +
            'Ask the user to open this assistant inside a workspace (or switch to a workspace-scoped chat) and repeat the edit there. ' +
            'Retrying updateBrainEntry on this surface will fail the same way.',
          isError: true,
        }
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
            ? `Updating ${input.primitive} ${input.rowId} was refused: this turn's findEditableBrainEntries returned MORE THAN ONE plausible entry, and picking one for the user is not this tool's call. Nothing was saved. ` +
              'Show the user the matches and ask which entry they mean, then re-issue with that one. Re-sending the same rowId without asking will be refused the same way.'
            : `Updating ${input.primitive} ${input.rowId} was refused: that primitive + rowId + revision triple was not returned by findEditableBrainEntries in THIS turn, and an unscoped chat may only edit a target this turn's own discovery produced (the model cannot supply an id from memory). Nothing was saved. ` +
              `Call ${BRAIN_DISCOVERY} now, then re-issue with the exact rowId and revision from that result. Retrying this call unchanged will be refused the same way.`,
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
          data:
            `Updating ${input.primitive} ${input.rowId} was refused: this conversation is scoped to ONE open Brain entry (${args.scopedEntry.primitive} ${args.scopedEntry.id}, revision ${revision(args.scopedEntry)}) and can edit no other, so nothing was saved. ` +
            `Re-issue with that exact primitive, rowId, and expectedUpdatedAt — they are in the "Currently viewing: Brain entry" block. ` +
            'If the user meant a different entry, tell them it has to be opened first; this call cannot reach it however it is retried.',
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
        return mutationFailure(input, result)
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
