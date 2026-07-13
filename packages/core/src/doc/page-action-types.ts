/**
 * Page actions — human-approved dispatch from doc pages.
 *
 * A page action is a BUTTON BINDING owned by the blueprint/page side (mig
 * 318 `page_actions`), never a workflow trigger kind: scope is exactly one
 * of `blueprintId` (the button shows on every page projected from that
 * blueprint, resolved through `blueprint_records.page_id`) or `pageId`
 * (that page only). The action itself is a closed discriminated union —
 * v1 ships `workflow` (start a button-triggered run with the page as
 * `input.event.pageId`) and `goal` (seed an Autopilot goal with the page as
 * context). `prompt` is a documented later extension and deliberately NOT
 * schema-admitted (capability-honesty rule).
 *
 * Zod here is the single boundary authority — the REST routes parse with
 * these schemas and the store persists the parsed value as jsonb.
 *
 * Spec: docs/architecture/features/page-actions.md.
 */

import { z } from 'zod'

export const PageActionSpecSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('workflow'),
      /** Workspace workflow started by the click (trigger_kind='button', inline advance). */
      workflowId: z.string().uuid(),
      /** Optional run-scope vars seeded into the run input (`{{input.vars.*}}`). */
      vars: z.record(z.unknown()).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('goal'),
      /**
       * Optional outcome seed for the Autopilot goal. Absent = derived from
       * the page title at invoke time. The goal rides the normal creation
       * path — clarity gate, verifier, metering all unchanged.
       */
      outcome: z.string().min(1).max(2000).optional(),
      /** Optional note appended to the goal's context. */
      note: z.string().min(1).max(2000).optional(),
    })
    .strict(),
])

export type PageActionSpec = z.infer<typeof PageActionSpecSchema>
export type PageActionKind = PageActionSpec['kind']

export const PAGE_ACTION_KINDS = ['workflow', 'goal'] as const satisfies readonly PageActionKind[]

/** One button binding row (mig 321 `page_actions`). */
export type PageAction = {
  id: string
  workspaceId: string
  /** Blueprint scope — mutually exclusive with `pageId` (DB CHECK). */
  blueprintId: string | null
  /** Single-page scope — mutually exclusive with `blueprintId` (DB CHECK). */
  pageId: string | null
  label: string
  icon: string | null
  /** Optional extra line rendered inside the confirm dialog. */
  confirmCopy: string | null
  action: PageActionSpec
  enabled: boolean
  position: number
  createdBy: string
  createdAt: string
  updatedAt: string
}

const scopeSchema = z.union([
  z.object({ blueprintId: z.string().uuid() }).strict(),
  z.object({ pageId: z.string().uuid() }).strict(),
])

/** REST create payload — exactly one scope, validated action union. */
export const CreatePageActionSchema = z.object({
  workspaceId: z.string().uuid(),
  scope: scopeSchema,
  label: z.string().min(1).max(64),
  icon: z.string().min(1).max(64).optional(),
  confirmCopy: z.string().min(1).max(500).optional(),
  action: PageActionSpecSchema,
  position: z.number().int().min(0).max(1000).optional(),
})
export type CreatePageActionInput = z.infer<typeof CreatePageActionSchema>

/** REST update payload — partial; scope is immutable after create. */
export const UpdatePageActionSchema = z
  .object({
    label: z.string().min(1).max(64).optional(),
    icon: z.string().min(1).max(64).nullable().optional(),
    confirmCopy: z.string().min(1).max(500).nullable().optional(),
    action: PageActionSpecSchema.optional(),
    enabled: z.boolean().optional(),
    position: z.number().int().min(0).max(1000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'update must change at least one field.')
export type UpdatePageActionInput = z.infer<typeof UpdatePageActionSchema>
