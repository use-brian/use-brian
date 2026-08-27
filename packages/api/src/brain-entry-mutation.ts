/**
 * Brain-entry mutation module.
 *
 * One interface owns the editable Review-entry matrix. The REST route and the
 * confirmed assistant tool are adapters over `mutate`, so validation,
 * authorization, auditing, notifications, and supersession cannot drift.
 *
 * Spec: docs/architecture/brain/corrections.md -> "Conversational entry editing".
 * [COMP:api/brain-entry-mutation]
 */

import type {
  DealStage,
  EntityLinksStore,
  TaskRecordStatus,
  TaskUpdateFields,
} from '@use-brian/core'
import { DEAL_STAGES, TASK_STATUSES } from '@use-brian/core'
import { query } from './db/client.js'
import type { WorkspaceStore } from './db/workspace-store.js'
import {
  applyBrainCorrection,
  getBrainInboxRow,
  listBrainInbox,
  markVerifiedGeneric,
  type BrainCorrectionVerification,
  type BrainInboxPrimitive,
  type BrainInboxRowDetail,
} from './db/brain-inbox-store.js'
import {
  getMemoryByIdSystem,
} from './db/memories.js'
import { adjustMemoryDecision } from './db/memory-verifications-store.js'
import { updateEntity } from './db/entities-store.js'
import {
  setDealStage,
  updateCompany,
  updateContact,
  updateDeal,
} from './db/crm.js'
import { updateWorkspaceFileMeta } from './db/workspace-files.js'
import { updateTask } from './db/tasks.js'
import { appendCrmActivity } from './db/crm-r2.js'
import { notifyBrainInboxChange } from './brain-stream/notify.js'

export const EDITABLE_BRAIN_PRIMITIVES = [
  'memory',
  'entity',
  'task',
  'contact',
  'company',
  'deal',
  'workspace_file',
] as const satisfies readonly BrainInboxPrimitive[]

export type EditableBrainPrimitive =
  (typeof EDITABLE_BRAIN_PRIMITIVES)[number]

class BrainMutationTargetMissingError extends Error {}

export const EDITABLE_FIELDS_BY_PRIMITIVE: Record<
  EditableBrainPrimitive,
  readonly string[]
> = {
  memory: ['summary', 'detail', 'scope', 'sensitivity'],
  entity: ['display_name', 'sensitivity'],
  task: [
    'title',
    'status',
    'due_at',
    'tags',
    'assignee_id',
    'priority',
    'description',
    'icon',
  ],
  contact: [
    'display_name',
    'sensitivity',
    'email',
    'phone',
    'company_id',
    'tags',
  ],
  company: ['display_name', 'sensitivity', 'domain', 'tags'],
  deal: [
    'display_name',
    'sensitivity',
    'stage',
    'amount',
    'close_date',
  ],
  workspace_file: ['sensitivity', 'tags'],
}

const VALID_PRIMITIVES: BrainInboxPrimitive[] = [
  ...EDITABLE_BRAIN_PRIMITIVES,
  'entity_link',
]

function isValidPrimitive(value: string): value is BrainInboxPrimitive {
  return (VALID_PRIMITIVES as string[]).includes(value)
}

export function isEditableBrainPrimitive(
  value: string,
): value is EditableBrainPrimitive {
  return (EDITABLE_BRAIN_PRIMITIVES as readonly string[]).includes(value)
}

function auditKind(primitive: BrainInboxPrimitive): BrainInboxPrimitive {
  return primitive === 'contact' ||
    primitive === 'company' ||
    primitive === 'deal'
    ? 'entity'
    : primitive
}

const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const

export type BrainEntryMutationRequest = {
  userId: string
  workspaceId: string
  primitive: string
  rowId: string
  changes: Record<string, unknown>
  /** Server-observed ISO timestamp frozen into an assistant confirmation. */
  expectedUpdatedAt?: string
}

export type BrainEntryMutationResult = {
  status: number
  body: Record<string, unknown>
}

export type EditableBrainEntry = BrainInboxRowDetail & {
  primitive: EditableBrainPrimitive
  label: string
  editableFields: readonly string[]
}

export type BrainEntryMutator = {
  getEditableEntry(
    workspaceId: string,
    primitive: string,
    rowId: string,
    viewer?: { userId: string; clearance?: 'public' | 'internal' | 'confidential' },
  ): Promise<EditableBrainEntry | null>
  findEditableEntries(
    workspaceId: string,
    queryText: string,
    limit?: number,
    viewer?: { userId: string; clearance?: 'public' | 'internal' | 'confidential' },
  ): Promise<EditableBrainEntry[]>
  mutate(
    request: BrainEntryMutationRequest,
  ): Promise<BrainEntryMutationResult>
}

type MutationResponse = {
  status(code: number): MutationResponse
  json(body: Record<string, unknown>): MutationResponse
}

function entryLabel(row: BrainInboxRowDetail): string {
  for (const key of ['summary', 'title', 'display_name', 'name']) {
    const value = row.body[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return `${row.primitive} ${row.id.slice(0, 8)}`
}

function projectEditable(
  row: BrainInboxRowDetail,
): EditableBrainEntry | null {
  if (!isEditableBrainPrimitive(row.primitive)) return null
  return {
    ...row,
    primitive: row.primitive,
    label: entryLabel(row),
    editableFields: EDITABLE_FIELDS_BY_PRIMITIVE[row.primitive],
  }
}

export function createBrainEntryMutator(args: {
  workspaceStore: WorkspaceStore
  entityLinks?: EntityLinksStore
}): BrainEntryMutator {
  const { workspaceStore, entityLinks } = args

  async function requireWorkspaceMember(
    req: { userId?: string; params: { workspaceId: string } },
    res: MutationResponse,
  ): Promise<string | null> {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return null
    }
    const role = await workspaceStore.getRole(
      req.userId,
      req.params.workspaceId,
    )
    if (!role) {
      res.status(403).json({ error: 'Not a member of this workspace' })
      return null
    }
    return role
  }

  async function handle(
    req: {
      userId: string
      params: {
        workspaceId: string
        primitive: string
        rowId: string
      }
      body: Record<string, unknown>
      expectedUpdatedAt?: string
    },
    res: MutationResponse,
  ): Promise<void> {
    const role = await requireWorkspaceMember(req, res)
    if (!role) return

    const { workspaceId, primitive: primitiveParam, rowId } = req.params as {
      workspaceId: string
      primitive: string
      rowId: string
    }
    if (!isValidPrimitive(primitiveParam)) {
      res.status(400).json({ error: `Unknown primitive '${primitiveParam}'` })
      return
    }
    const userId = req.userId

    if (req.expectedUpdatedAt) {
      const current = await getBrainInboxRow(workspaceId, primitiveParam, rowId)
      if (!current) {
        res.status(404).json({ error: 'Row not found' })
        return
      }
      if (current.updatedAt.toISOString() !== req.expectedUpdatedAt) {
        res.status(409).json({
          error: 'The entry changed while this edit was awaiting approval. Review the latest version and try again.',
          code: 'stale_entry',
        })
        return
      }
    }

    if (primitiveParam === 'memory') {
      // Every memory uses this shared mutation seam. The former REST-only
      // redirect fork duplicated validation and audit behavior.
      const { scope, sensitivity, summary, detail, reason } = req.body as {
        scope?: string
        sensitivity?: string
        summary?: string
        detail?: string
        reason?: string
      }

      // Validate up front (mirrors memories.ts adjust) so we never mint a
      // partial audit trail before bailing on a downstream error.
      let nextScope: 'shared' | 'workspace' | undefined
      let nextWorkspaceId: string | null | undefined
      let scopeUserValue: 'personal' | 'workspace_shared' | 'workspace' | undefined
      if (scope !== undefined) {
        if (scope === 'personal') {
          nextScope = 'shared'
          nextWorkspaceId = null
          scopeUserValue = 'personal'
        } else if (scope === 'workspace_shared') {
          nextScope = 'shared'
          scopeUserValue = 'workspace_shared'
        } else if (scope === 'workspace') {
          nextScope = 'workspace'
          scopeUserValue = 'workspace'
        } else {
          res
            .status(400)
            .json({ error: 'scope must be personal, workspace_shared, or workspace' })
          return
        }
      }

      let nextSensitivity: 'public' | 'internal' | 'confidential' | undefined
      if (sensitivity !== undefined) {
        if (
          sensitivity !== 'public' &&
          sensitivity !== 'internal' &&
          sensitivity !== 'confidential'
        ) {
          res
            .status(400)
            .json({ error: 'sensitivity must be public, internal, or confidential' })
          return
        }
        nextSensitivity = sensitivity
      }

      let nextSummary: string | undefined
      if (summary !== undefined) {
        if (typeof summary !== 'string' || summary.trim().length === 0) {
          res.status(400).json({ error: 'summary must be a non-empty string' })
          return
        }
        if (summary.length > 500) {
          res.status(400).json({ error: 'summary must be 500 characters or less' })
          return
        }
        nextSummary = summary.trim()
      }

      let nextDetail: string | undefined
      if (detail !== undefined) {
        if (typeof detail !== 'string') {
          res.status(400).json({ error: 'detail must be a string' })
          return
        }
        nextDetail = detail
      }

      if (
        nextScope === undefined &&
        nextSensitivity === undefined &&
        nextSummary === undefined &&
        nextDetail === undefined
      ) {
        res.status(400).json({
          error:
            'At least one field (scope, sensitivity, summary, detail) is required',
        })
        return
      }

      try {
        const before = await getMemoryByIdSystem(rowId)
        // Authz: the memory must live in the workspace the caller is a
        // member of (gated above). Replaces the per-assistant route's
        // `before.assistantId === assistantId` membership check.
        if (!before || before.workspaceId !== workspaceId) {
          res.status(404).json({ error: 'Memory not found' })
          return
        }

        // Default workspaceId for workspace/workspace_shared scope to the
        // memory's own workspace; explicit personal scope clears it.
        const computedWorkspaceId =
          nextWorkspaceId === null
            ? null
            : nextScope !== undefined
              ? before.workspaceId
              : undefined

        const reasonText = typeof reason === 'string' ? reason.slice(0, 500) : undefined
        const verifications: Parameters<typeof adjustMemoryDecision>[0]['verifications'] = []
        if (nextScope !== undefined) {
          const modelScope =
            before.scope === 'workspace'
              ? 'workspace'
              : before.workspaceId
                ? 'workspace_shared'
                : 'personal'
          if (modelScope !== scopeUserValue) {
            verifications.push(
              {
                action: 'adjust_scope',
                modelValue: modelScope,
                userValue: scopeUserValue,
                reason: reasonText,
              },
            )
          }
        }
        if (nextSensitivity !== undefined && nextSensitivity !== before.sensitivity) {
          verifications.push(
            {
              action: 'adjust_sensitivity',
              modelValue: before.sensitivity,
              userValue: nextSensitivity,
              reason: reasonText,
            },
          )
        }
        if (
          (nextSummary !== undefined && nextSummary !== before.summary) ||
          (nextDetail !== undefined && nextDetail !== before.detail)
        ) {
          verifications.push(
            {
              action: 'edit_summary',
              modelValue: { summary: before.summary, detail: before.detail },
              userValue: {
                summary: nextSummary ?? before.summary,
                detail: nextDetail ?? before.detail,
              },
              reason: reasonText,
            },
          )
        }
        const stamped = await adjustMemoryDecision({
          memoryId: rowId,
          workspaceId: before.workspaceId,
          verifiedBy: userId,
          updates: {
            scope: nextScope,
            workspaceId: computedWorkspaceId,
            sensitivity: nextSensitivity,
            summary: nextSummary,
            detail: nextDetail,
          },
          verifications,
        })
        if (!stamped) {
          res.status(404).json({ error: 'Memory not found' })
          return
        }
        void notifyBrainInboxChange(
          stamped.workspaceId ?? before.workspaceId,
          'memory',
          stamped.id,
          'update',
        )
        res.json({ memory: stamped })
      } catch (err) {
        console.error('[brain-inbox] workspace memory adjust failed:', err)
        res.status(500).json({ error: 'Failed to adjust memory' })
      }
      return
    }

    if (primitiveParam === 'entity') {
      // Entity adjust — v1 supports display_name + sensitivity only.
      const { display_name, sensitivity, reason } = req.body as {
        display_name?: unknown
        sensitivity?: unknown
        reason?: unknown
      }

      let nextDisplayName: string | undefined
      if (display_name !== undefined) {
        if (typeof display_name !== 'string' || display_name.trim().length === 0) {
          res.status(400).json({ error: 'display_name must be a non-empty string' })
          return
        }
        if (display_name.length > 200) {
          res.status(400).json({ error: 'display_name must be 200 characters or less' })
          return
        }
        nextDisplayName = display_name.trim()
      }

      let nextSensitivity: 'public' | 'internal' | 'confidential' | undefined
      if (sensitivity !== undefined) {
        if (
          sensitivity !== 'public' &&
          sensitivity !== 'internal' &&
          sensitivity !== 'confidential'
        ) {
          res.status(400).json({ error: 'sensitivity must be public, internal, or confidential' })
          return
        }
        nextSensitivity = sensitivity
      }

      if (nextDisplayName === undefined && nextSensitivity === undefined) {
        res.status(400).json({
          error: 'At least one field (display_name, sensitivity) is required',
        })
        return
      }

      try {
        const before = await query<{
          workspaceId: string
          displayName: string
          sensitivity: 'public' | 'internal' | 'confidential'
        }>(
          `SELECT workspace_id as "workspaceId",
                  display_name as "displayName",
                  sensitivity
             FROM entities
            WHERE id = $1 AND valid_to IS NULL`,
          [rowId],
        )
        if (before.rows.length === 0) {
          res.status(404).json({ error: 'Entity not found' })
          return
        }
        if (before.rows[0].workspaceId !== workspaceId) {
          res.status(403).json({ error: 'Entity belongs to a different workspace' })
          return
        }
        const prev = before.rows[0]

        const reasonText = typeof reason === 'string' ? reason.slice(0, 500) : undefined
        // Write under the viewer's workspace projection (primary-reflector
        // shape — the route already verified workspace membership above).
        const updated = await applyBrainCorrection({
          mutate: (client) => updateEntity(userId, rowId, {
            displayName: nextDisplayName,
            sensitivity: nextSensitivity,
            verifiedByUserId: userId,
            verifiedAt: new Date(),
          }, { workspaceId, userId, assistantId: '', assistantKind: 'primary' }, client),
          verifications: (result) => {
            if (!result) return []
            const verifications: BrainCorrectionVerification[] = []
            if (nextDisplayName !== undefined && nextDisplayName !== prev.displayName) {
              verifications.push({
                targetKind: 'entity',
                targetId: rowId,
                workspaceId,
                verifiedByUserId: userId,
                action: 'edit_summary',
                modelValue: { display_name: prev.displayName },
                userValue: { display_name: nextDisplayName },
                reason: reasonText,
              })
            }
            if (nextSensitivity !== undefined && nextSensitivity !== prev.sensitivity) {
              verifications.push({
                targetKind: 'entity',
                targetId: rowId,
                workspaceId,
                verifiedByUserId: userId,
                action: 'adjust_sensitivity',
                modelValue: prev.sensitivity,
                userValue: nextSensitivity,
                reason: reasonText,
              })
            }
            return verifications
          },
        })
        if (!updated) {
          res.status(404).json({ error: 'Entity not found' })
          return
        }

        // Realtime repaint for the adjusted entity row.
        void notifyBrainInboxChange(workspaceId, 'entity', rowId, 'update')

        res.json({ ok: true, stamped: true })
      } catch (err) {
        console.error('[brain-inbox] entity adjust failed:', err)
        res.status(500).json({ error: 'Failed to adjust entity' })
      }
      return
    }

    if (primitiveParam === 'company' || primitiveParam === 'contact' || primitiveParam === 'deal') {
      // CRM-row adjust — the shared fields (`display_name`, `sensitivity`)
      // plus the kind-typed fields the CRM operator surface edits inline
      // (crm.md → "Operator surface"):
      //   - contact : email / phone / company_id (nullable-clear) + tags
      //   - company : domain (nullable-clear) + tags
      //   - deal    : amount / close_date (nullable-clear) + stage
      // Typed fields apply through the access-scoped crm.ts helpers
      // (updateContact / updateCompany / updateDeal), with `stage` routed
      // ONLY through setDealStage — the canonical stage-transition verb and
      // the future sync cut-point (crm.md decision 13). A field that does
      // not belong to the primitive kind is a 400, not a silent drop.
      const { display_name, sensitivity, reason, email, phone, company_id, tags, domain, stage, amount, close_date } = req.body as {
        display_name?: unknown
        sensitivity?: unknown
        reason?: unknown
        email?: unknown
        phone?: unknown
        company_id?: unknown
        tags?: unknown
        domain?: unknown
        stage?: unknown
        amount?: unknown
        close_date?: unknown
      }

      // Kind-mismatch guard: reject typed fields sent to the wrong kind.
      const TYPED_FIELDS_BY_KIND: Record<'contact' | 'company' | 'deal', readonly string[]> = {
        contact: ['email', 'phone', 'company_id', 'tags'],
        company: ['domain', 'tags'],
        deal: ['stage', 'amount', 'close_date'],
      }
      const allowedTyped = TYPED_FIELDS_BY_KIND[primitiveParam]
      const sentTyped = (
        [
          ['email', email], ['phone', phone], ['company_id', company_id], ['tags', tags],
          ['domain', domain], ['stage', stage], ['amount', amount], ['close_date', close_date],
        ] as const
      ).filter(([, v]) => v !== undefined)
      const misplaced = sentTyped.find(([key]) => !allowedTyped.includes(key))
      if (misplaced) {
        res.status(400).json({
          error: `${misplaced[0]} is not a valid field for ${primitiveParam}`,
        })
        return
      }

      /** Validate a nullable short-string field (null clears; trimmed). */
      const nullableStr = (
        value: unknown,
        label: string,
        maxLen: number,
      ): { ok: true; value: string | null | undefined } | { ok: false; error: string } => {
        if (value === undefined) return { ok: true, value: undefined }
        if (value === null) return { ok: true, value: null }
        if (typeof value !== 'string' || value.trim().length === 0) {
          return { ok: false, error: `${label} must be a non-empty string or null` }
        }
        if (value.length > maxLen) {
          return { ok: false, error: `${label} must be ${maxLen} characters or less` }
        }
        return { ok: true, value: value.trim() }
      }

      const emailV = nullableStr(email, 'email', 320)
      if (!emailV.ok) { res.status(400).json({ error: emailV.error }); return }
      const phoneV = nullableStr(phone, 'phone', 64)
      if (!phoneV.ok) { res.status(400).json({ error: phoneV.error }); return }
      const domainV = nullableStr(domain, 'domain', 256)
      if (!domainV.ok) { res.status(400).json({ error: domainV.error }); return }

      let nextCompanyId: string | null | undefined
      if (company_id !== undefined) {
        if (company_id === null) nextCompanyId = null
        else if (typeof company_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(company_id)) {
          nextCompanyId = company_id
        } else {
          res.status(400).json({ error: 'company_id must be an entity id or null' })
          return
        }
      }

      let nextTags: string[] | undefined
      if (tags !== undefined) {
        if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) {
          res.status(400).json({ error: 'tags must be an array of strings' })
          return
        }
        nextTags = (tags as string[]).map((t) => t.trim()).filter((t) => t.length > 0).slice(0, 50)
      }

      let nextStage: DealStage | undefined
      if (stage !== undefined) {
        if (typeof stage !== 'string' || !(DEAL_STAGES as readonly string[]).includes(stage)) {
          res.status(400).json({ error: `stage must be one of: ${DEAL_STAGES.join(', ')}` })
          return
        }
        nextStage = stage as DealStage
      }

      let nextAmount: number | null | undefined
      if (amount !== undefined) {
        if (amount === null) nextAmount = null
        else if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) {
          nextAmount = amount
        } else {
          res.status(400).json({ error: 'amount must be a non-negative number or null' })
          return
        }
      }

      let nextCloseDate: Date | null | undefined
      if (close_date !== undefined) {
        if (close_date === null) nextCloseDate = null
        else if (typeof close_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(close_date)) {
          // UTC-midnight parse — the store writes back toISOString().slice(0,10),
          // so the calendar date round-trips exactly.
          const d = new Date(close_date)
          if (isNaN(d.getTime())) {
            res.status(400).json({ error: 'close_date must be a valid YYYY-MM-DD date or null' })
            return
          }
          nextCloseDate = d
        } else {
          res.status(400).json({ error: 'close_date must be a valid YYYY-MM-DD date or null' })
          return
        }
      }

      const hasTypedChange = sentTyped.length > 0

      let nextName: string | undefined
      if (display_name !== undefined) {
        if (typeof display_name !== 'string' || display_name.trim().length === 0) {
          res.status(400).json({ error: 'display_name must be a non-empty string' })
          return
        }
        if (display_name.length > 200) {
          res.status(400).json({ error: 'display_name must be 200 characters or less' })
          return
        }
        nextName = display_name.trim()
      }

      let nextSensitivity: 'public' | 'internal' | 'confidential' | undefined
      if (sensitivity !== undefined) {
        if (
          sensitivity !== 'public'
          && sensitivity !== 'internal'
          && sensitivity !== 'confidential'
        ) {
          res.status(400).json({ error: 'sensitivity must be public, internal, or confidential' })
          return
        }
        nextSensitivity = sensitivity
      }

      if (nextName === undefined && nextSensitivity === undefined && !hasTypedChange) {
        res.status(400).json({
          error: 'At least one field (display_name, sensitivity, or a kind-typed field) is required',
        })
        return
      }

      try {
        // Post CRM→entity unification the CRM row IS the entity — read it
        // directly; the record id is the entity id (entityId == rowId).
        const before = await query<{
          workspaceId: string
          name: string | null
          sensitivity: 'public' | 'internal' | 'confidential'
          entityId: string | null
          attributes: Record<string, unknown> | null
        }>(
          `SELECT workspace_id AS "workspaceId", display_name AS name, sensitivity,
                  id AS "entityId", attributes
             FROM entities
            WHERE id = $1 AND valid_to IS NULL`,
          [rowId],
        )
        if (before.rows.length === 0) {
          res.status(404).json({ error: 'Row not found' })
          return
        }
        if (before.rows[0].workspaceId !== workspaceId) {
          res.status(403).json({ error: 'Row belongs to a different workspace' })
          return
        }
        const prev = before.rows[0]

        const reasonText = typeof reason === 'string' ? reason.slice(0, 500) : undefined
        const access = {
          workspaceId, userId, assistantId: '', assistantKind: 'primary',
        } as const
        await applyBrainCorrection({
          mutate: async (client) => {
            // The CRM row IS the entity now — a single updateEntity write
            // covers display_name + sensitivity.
            if (prev.entityId && (nextName !== undefined || nextSensitivity !== undefined)) {
              const updated = await updateEntity(userId, prev.entityId, {
                ...(nextName !== undefined ? { displayName: nextName } : {}),
                ...(nextSensitivity !== undefined ? { sensitivity: nextSensitivity } : {}),
                verifiedByUserId: userId,
                verifiedAt: new Date(),
              }, access, client)
              if (!updated) throw new BrainMutationTargetMissingError()
            }

            // Kind-typed fields go through the access-scoped crm.ts helpers.
            if (hasTypedChange) {
              if (primitiveParam === 'contact') {
                const updated = await updateContact(userId, rowId, {
                  ...(emailV.value !== undefined ? { email: emailV.value } : {}),
                  ...(phoneV.value !== undefined ? { phone: phoneV.value } : {}),
                  ...(nextCompanyId !== undefined ? { companyId: nextCompanyId } : {}),
                  ...(nextTags !== undefined ? { tags: nextTags } : {}),
                }, entityLinks, access, client)
                if (!updated) throw new BrainMutationTargetMissingError()
              } else if (primitiveParam === 'company') {
                const updated = await updateCompany(userId, rowId, {
                  ...(domainV.value !== undefined ? { domain: domainV.value } : {}),
                  ...(nextTags !== undefined ? { tags: nextTags } : {}),
                }, access, client)
                if (!updated) throw new BrainMutationTargetMissingError()
              } else {
                if (nextAmount !== undefined || nextCloseDate !== undefined) {
                  const updated = await updateDeal(userId, rowId, {
                    ...(nextAmount !== undefined ? { amount: nextAmount } : {}),
                    ...(nextCloseDate !== undefined ? { closeDate: nextCloseDate } : {}),
                  }, entityLinks, access, client)
                  if (!updated) throw new BrainMutationTargetMissingError()
                }
                // Stage is LAST and only via setDealStage — the canonical
                // stage-transition verb (crm.md decision 13; never updateDeal).
                if (nextStage !== undefined) {
                  const updated = await setDealStage(userId, rowId, nextStage, access, client)
                  if (!updated) throw new BrainMutationTargetMissingError()
                }
              }
            }
            return true
          },
          verifications: () => {
            const verifications: BrainCorrectionVerification[] = []
            if (hasTypedChange) {
              const beforeAttrs = prev.attributes ?? {}
              verifications.push({
                targetKind: auditKind(primitiveParam),
                targetId: rowId,
                workspaceId,
                verifiedByUserId: userId,
                action: 'adjust_attributes',
                modelValue: Object.fromEntries(
                  sentTyped.map(([k]) => [k, beforeAttrs[k] ?? null]),
                ),
                userValue: Object.fromEntries(
                  sentTyped.map(([k, v]) => [k, v ?? null]),
                ),
                reason: reasonText,
              })
            }
            if (nextName !== undefined && nextName !== prev.name) {
              verifications.push({
                targetKind: auditKind(primitiveParam),
                targetId: rowId,
                workspaceId,
                verifiedByUserId: userId,
                action: 'edit_summary',
                modelValue: { name: prev.name },
                userValue: { name: nextName },
                reason: reasonText,
              })
            }
            if (nextSensitivity !== undefined && nextSensitivity !== prev.sensitivity) {
              verifications.push({
                targetKind: auditKind(primitiveParam),
                targetId: rowId,
                workspaceId,
                verifiedByUserId: userId,
                action: 'adjust_sensitivity',
                modelValue: prev.sensitivity,
                userValue: nextSensitivity,
                reason: reasonText,
              })
            }
            return verifications
          },
        })

        const changedFields = [
          ...(nextName !== undefined ? ['display_name'] : []),
          ...(nextSensitivity !== undefined ? ['sensitivity'] : []),
          ...sentTyped.map(([key]) => key),
        ]
        if (changedFields.length > 0) {
          const beforeValues: Record<string, unknown> = {}
          const afterValues: Record<string, unknown> = {}
          if (nextName !== undefined) {
            beforeValues.display_name = prev.name
            afterValues.display_name = nextName
          }
          if (nextSensitivity !== undefined) {
            beforeValues.sensitivity = prev.sensitivity
            afterValues.sensitivity = nextSensitivity
          }
          for (const [key, value] of sentTyped) {
            beforeValues[key] = (prev.attributes ?? {})[key] ?? null
            afterValues[key] = value ?? null
          }
          const stageChanged = nextStage !== undefined
          // The CRM write is already committed. Activity history is a
          // best-effort append and must never turn a successful edit into a
          // false 500; retryable producers can use source ids when needed.
          void appendCrmActivity({
            userId,
            workspaceId,
            entityId: rowId,
            activityType: stageChanged ? 'stage_change' : 'field_change',
            summary: stageChanged ? 'Deal stage changed' : 'CRM fields updated',
            metadata: {
              fields: changedFields,
              before: beforeValues,
              after: afterValues,
              ...(stageChanged
                ? { fromStage: (prev.attributes ?? {}).stage ?? null, toStage: nextStage }
                : {}),
            },
          }).catch((err) => console.error('[brain-entry-mutation] CRM activity append failed:', err))
        }

        // Realtime repaint: the CRM row itself, plus the linked entity when
        // this adjust mirrored name / sensitivity onto it (the graph view +
        // brain-search read the entity row, the list view reads the CRM row).
        void notifyBrainInboxChange(workspaceId, primitiveParam, rowId, 'update')
        if (prev.entityId && (nextName !== undefined || nextSensitivity !== undefined)) {
          void notifyBrainInboxChange(workspaceId, 'entity', prev.entityId, 'update')
        }

        res.json({ ok: true, stamped: true })
      } catch (err) {
        if (err instanceof BrainMutationTargetMissingError) {
          res.status(404).json({ error: 'Row not found' })
          return
        }
        console.error(`[brain-inbox] ${primitiveParam} adjust failed:`, err)
        // App-layer frozen-v1 constraint violations (crm.ts) are caller
        // errors, not server faults: surface them as 400s.
        const message = err instanceof Error ? err.message : String(err)
        if (
          message.includes('deals_stage_check')
          || message.includes('deals_amount_check')
          || message.includes('same workspace')
        ) {
          res.status(400).json({ error: message })
          return
        }
        res.status(500).json({ error: `Failed to adjust ${primitiveParam}` })
      }
      return
    }

    if (primitiveParam === 'workspace_file') {
      // File adjust — v1 supports `sensitivity` + `tags`. `name` is the
      // path-coupled display name, so rename stays out of scope; substantive
      // content edits route through supersession, not this metadata patch.
      const { sensitivity, tags, reason } = req.body as {
        sensitivity?: unknown
        tags?: unknown
        reason?: unknown
      }

      let nextSensitivity: 'public' | 'internal' | 'confidential' | undefined
      if (sensitivity !== undefined) {
        if (
          sensitivity !== 'public'
          && sensitivity !== 'internal'
          && sensitivity !== 'confidential'
        ) {
          res.status(400).json({ error: 'sensitivity must be public, internal, or confidential' })
          return
        }
        nextSensitivity = sensitivity
      }

      let nextTags: string[] | undefined
      if (tags !== undefined) {
        if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) {
          res.status(400).json({ error: 'tags must be an array of strings' })
          return
        }
        nextTags = (tags as string[]).map((t) => t.trim()).filter((t) => t.length > 0).slice(0, 50)
      }

      if (nextSensitivity === undefined && nextTags === undefined) {
        res.status(400).json({ error: 'At least one field (sensitivity, tags) is required' })
        return
      }

      try {
        const before = await query<{
          workspaceId: string
          sensitivity: 'public' | 'internal' | 'confidential'
          tags: string[]
        }>(
          `SELECT workspace_id AS "workspaceId", sensitivity, tags
             FROM workspace_files
            WHERE id = $1 AND valid_to IS NULL`,
          [rowId],
        )
        if (before.rows.length === 0) {
          res.status(404).json({ error: 'File not found' })
          return
        }
        if (before.rows[0].workspaceId !== workspaceId) {
          res.status(403).json({ error: 'File belongs to a different workspace' })
          return
        }
        const prev = before.rows[0]

        const reasonText = typeof reason === 'string' ? reason.slice(0, 500) : undefined
        const updated = await applyBrainCorrection({
          mutate: async (client) => {
            const result = await updateWorkspaceFileMeta(userId, workspaceId, rowId, {
              ...(nextSensitivity !== undefined ? { sensitivity: nextSensitivity } : {}),
              ...(nextTags !== undefined ? { tags: nextTags } : {}),
            }, client)
            if (result) {
              // An explicit edit acknowledges the row and removes it from the
              // pending queue under the same correction transaction.
              await markVerifiedGeneric('workspace_file', rowId, userId, client)
            }
            return result
          },
          verifications: (result) => {
            if (!result) return []
            const verifications: BrainCorrectionVerification[] = []
            if (nextSensitivity !== undefined && nextSensitivity !== prev.sensitivity) {
              verifications.push({
                targetKind: 'workspace_file',
                targetId: rowId,
                workspaceId,
                verifiedByUserId: userId,
                action: 'adjust_sensitivity',
                modelValue: prev.sensitivity,
                userValue: nextSensitivity,
                reason: reasonText,
              })
            }
            if (nextTags !== undefined) {
              verifications.push({
                targetKind: 'workspace_file',
                targetId: rowId,
                workspaceId,
                verifiedByUserId: userId,
                action: 'adjust_attributes',
                modelValue: { tags: prev.tags },
                userValue: { tags: nextTags },
                reason: reasonText,
              })
            }
            return verifications
          },
        })
        if (!updated) {
          res.status(404).json({ error: 'File not found' })
          return
        }

        void notifyBrainInboxChange(workspaceId, 'workspace_file', rowId, 'update')
        res.json({ ok: true, stamped: true })
      } catch (err) {
        console.error('[brain-inbox] workspace_file adjust failed:', err)
        res.status(500).json({ error: 'Failed to adjust file' })
      }
      return
    }

    if (primitiveParam === 'task') {
      // Task adjust — the editable fields surfaced in the Brain detail
      // panel: title, status, due date, tags, assignee, priority,
      // description, and icon. `assignee_id` must be a workspace_members row
      // id in THIS workspace (null clears). `priority`, `description`, and
      // `icon` are conventional `attributes.*` keys (the frozen-v1 schema has
      // no typed columns — tasks.md decision #1), merged into the row's
      // attributes (null removes the key) so sibling keys survive. Each edit
      // supersedes the row (a new bi-temporal id), so the preserved old
      // row IS the audit trail — no brain_verification stamp here.
      const { title, status, due_at, tags, assignee_id, priority, description, icon } = req.body as {
        title?: unknown
        status?: unknown
        due_at?: unknown
        tags?: unknown
        assignee_id?: unknown
        priority?: unknown
        description?: unknown
        icon?: unknown
      }

      const fields: TaskUpdateFields = {}

      if (title !== undefined) {
        if (typeof title !== 'string' || title.trim().length === 0) {
          res.status(400).json({ error: 'title must be a non-empty string' })
          return
        }
        if (title.length > 500) {
          res.status(400).json({ error: 'title must be 500 characters or less' })
          return
        }
        fields.title = title.trim()
      }

      if (status !== undefined) {
        if (!TASK_STATUSES.includes(status as TaskRecordStatus)) {
          res.status(400).json({
            error: `status must be one of ${TASK_STATUSES.join(', ')}`,
          })
          return
        }
        fields.status = status as TaskRecordStatus
      }

      if (due_at !== undefined) {
        // null clears the due date; a string must parse to a valid date.
        if (due_at === null) {
          fields.due = null
        } else if (typeof due_at === 'string') {
          const parsed = new Date(due_at)
          if (Number.isNaN(parsed.getTime())) {
            res.status(400).json({ error: 'due_at must be an ISO date string or null' })
            return
          }
          fields.due = parsed
        } else {
          res.status(400).json({ error: 'due_at must be an ISO date string or null' })
          return
        }
      }

      if (tags !== undefined) {
        if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) {
          res.status(400).json({ error: 'tags must be an array of strings' })
          return
        }
        fields.tags = (tags as string[]).map((s) => s.trim()).filter(Boolean)
      }

      if (assignee_id !== undefined) {
        // null clears; a string is validated against workspace_members below
        // (after the ownership pre-check) so a cross-workspace member id can
        // never land on a task.
        if (assignee_id !== null && (typeof assignee_id !== 'string' || assignee_id.length === 0)) {
          res.status(400).json({ error: 'assignee_id must be a workspace member id or null' })
          return
        }
        fields.assigneeId = assignee_id as string | null
      }

      // Tracked outside `fields` — it merges into the row's current
      // attributes, which we only have after the pre-check SELECT.
      let priorityChange: string | null | undefined
      if (priority !== undefined) {
        if (priority !== null && !TASK_PRIORITIES.includes(priority as (typeof TASK_PRIORITIES)[number])) {
          res.status(400).json({
            error: `priority must be one of ${TASK_PRIORITIES.join(', ')}, or null to clear`,
          })
          return
        }
        priorityChange = priority as string | null
      }

      // The task's page-body markdown (the peek/drawer "Description"
      // section). Free-form; capped so a paste can't balloon the row.
      let descriptionChange: string | null | undefined
      if (description !== undefined) {
        if (description === null) descriptionChange = null
        else if (typeof description === 'string' && description.length <= 10_000) {
          descriptionChange = description.trim().length > 0 ? description : null
        } else {
          res.status(400).json({
            error: 'description must be a string of 10000 characters or less, or null to clear',
          })
          return
        }
      }

      // Optional task emoji — the same compact convention as page emoji
      // icons. The operator picker only emits one grapheme; the API keeps a
      // tolerant 16-code-point ceiling for joined/skin-tone emoji sequences.
      let iconChange: string | null | undefined
      if (icon !== undefined) {
        if (icon === null) iconChange = null
        else if (
          typeof icon === 'string'
          && icon.trim().length > 0
          && Array.from(icon).length <= 16
        ) {
          iconChange = icon
        } else {
          res.status(400).json({
            error: 'icon must be a non-empty emoji of 16 Unicode code points or less, or null to clear',
          })
          return
        }
      }

      if (
        Object.keys(fields).length === 0
        && priorityChange === undefined
        && descriptionChange === undefined
        && iconChange === undefined
      ) {
        res.status(400).json({
          error: 'At least one field (title, status, due_at, tags, assignee_id, priority, description, icon) is required',
        })
        return
      }

      try {
        // Workspace-ownership check — requireWorkspaceMember already gated
        // membership; this confirms the row lives in *this* workspace and
        // distinguishes 404 (gone) from 403 (cross-workspace). Also carries
        // the live attributes so a priority change merges instead of
        // clobbering sibling keys (attributes is overwrite-on-update).
        const before = await query<{ workspaceId: string; attributes: unknown }>(
          `SELECT workspace_id as "workspaceId", attributes FROM tasks WHERE id = $1 AND valid_to IS NULL`,
          [rowId],
        )
        if (before.rows.length === 0) {
          res.status(404).json({ error: 'Task not found' })
          return
        }
        if (before.rows[0].workspaceId !== workspaceId) {
          res.status(403).json({ error: 'Task belongs to a different workspace' })
          return
        }

        if (typeof fields.assigneeId === 'string') {
          const member = await query(
            `SELECT id FROM workspace_members WHERE id = $1 AND workspace_id = $2`,
            [fields.assigneeId, workspaceId],
          )
          if (member.rows.length === 0) {
            res.status(400).json({ error: 'assignee_id is not a member of this workspace' })
            return
          }
        }

        if (
          priorityChange !== undefined
          || descriptionChange !== undefined
          || iconChange !== undefined
        ) {
          const raw = before.rows[0].attributes
          const attrs: Record<string, unknown> =
            raw && typeof raw === 'object' && !Array.isArray(raw)
              ? { ...(raw as Record<string, unknown>) }
              : {}
          if (priorityChange !== undefined) {
            if (priorityChange === null) delete attrs.priority
            else attrs.priority = priorityChange
          }
          if (descriptionChange !== undefined) {
            if (descriptionChange === null) delete attrs.description
            else attrs.description = descriptionChange
          }
          if (iconChange !== undefined) {
            if (iconChange === null) delete attrs.icon
            else attrs.icon = iconChange
          }
          fields.attributes = attrs
        }

        const updated = await updateTask(userId, rowId, fields)
        if (!updated) {
          res.status(404).json({ error: 'Task not found' })
          return
        }

        // Supersession mints a new id; return it so the client can re-anchor
        // (the panel closes + refetches, so a stale id never lingers).
        void notifyBrainInboxChange(workspaceId, 'task', rowId, 'update')
        res.json({ ok: true, stamped: true, id: updated.id })
      } catch (err) {
        console.error('[brain-inbox] task adjust failed:', err)
        res.status(500).json({ error: 'Failed to adjust task' })
      }
      return
    }

    res.status(405).json({
      error:
        `Inline adjust not yet supported for primitive '${primitiveParam}'. ` +
        `Use the detail page (e.g., /task/:id) to edit.`,
    })
  }

  return {
    async getEditableEntry(workspaceId, primitive, rowId, viewer) {
      if (!isEditableBrainPrimitive(primitive)) return null
      if (viewer) {
        const role = await workspaceStore.getRole(viewer.userId, workspaceId)
        if (!role) return null
      }
      const row = await getBrainInboxRow(workspaceId, primitive, rowId)
      if (!row) return null
      if (viewer) {
        const sensitivity = row.body.sensitivity
        const rank = { public: 0, internal: 1, confidential: 2 } as const
        const ceiling = viewer.clearance ?? 'confidential'
        if (
          typeof sensitivity === 'string' &&
          sensitivity in rank &&
          rank[sensitivity as keyof typeof rank] > rank[ceiling]
        ) return null
        // Personal visibility doubles are never editable by a different user.
        const ownerUserId = row.body.user_id
        if (
          typeof ownerUserId === 'string' &&
          ownerUserId.length > 0 &&
          ownerUserId !== viewer.userId
        ) return null
      }
      return projectEditable(row)
    },

    async findEditableEntries(workspaceId, queryText, limit = 8, viewer) {
      if (viewer) {
        const role = await workspaceStore.getRole(viewer.userId, workspaceId)
        if (!role) return []
      }
      const needle = queryText.trim().toLocaleLowerCase()
      if (!needle) return []
      const { rows } = await listBrainInbox({
        workspaceId,
        includeExtracted: true,
        limit: 100,
      })
      return rows
        .map((row) => projectEditable({
          ...row,
          verifiedByUserId: null,
          verifiedAt: null,
        }))
        .filter((row): row is EditableBrainEntry => row !== null)
        .filter((row) => {
          if (!viewer) return true
          const sensitivity = row.body.sensitivity
          const rank = { public: 0, internal: 1, confidential: 2 } as const
          const ceiling = viewer.clearance ?? 'confidential'
          if (
            typeof sensitivity === 'string' &&
            sensitivity in rank &&
            rank[sensitivity as keyof typeof rank] > rank[ceiling]
          ) return false
          const ownerUserId = row.body.user_id
          return !(
            typeof ownerUserId === 'string' &&
            ownerUserId.length > 0 &&
            ownerUserId !== viewer.userId
          )
        })
        .map((row) => ({
          row,
          haystack: `${row.label}\n${JSON.stringify(row.body)}`
            .toLocaleLowerCase(),
        }))
        .filter(({ haystack }) => haystack.includes(needle))
        .sort((a, b) => {
          const aExact = a.row.label.toLocaleLowerCase() === needle ? 1 : 0
          const bExact = b.row.label.toLocaleLowerCase() === needle ? 1 : 0
          return bExact - aExact ||
            b.row.updatedAt.getTime() - a.row.updatedAt.getTime()
        })
        .slice(0, Math.min(Math.max(limit, 1), 20))
        .map(({ row }) => row)
    },

    async mutate(request) {
      let status = 200
      let responseBody: Record<string, unknown> = {
        error: 'Mutation produced no response',
      }
      const response: MutationResponse = {
        status(code) {
          status = code
          return response
        },
        json(value) {
          responseBody = value
          return response
        },
      }
      await handle(
        {
          userId: request.userId,
          params: {
            workspaceId: request.workspaceId,
            primitive: request.primitive,
            rowId: request.rowId,
          },
          body: request.changes,
          expectedUpdatedAt: request.expectedUpdatedAt,
        },
        response,
      )
      return { status, body: responseBody }
    },
  }
}
