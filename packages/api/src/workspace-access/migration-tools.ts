import {inspectMigrationInventory, getMigrationInventory, migrationInventoryPageInput} from './migration-inventory.js'
import { buildTool, type Tool, type ToolContext } from '@use-brian/core'
import { z } from 'zod'
import { WorkspaceAccessError } from './policy.js'
import { getWorkspaceAccessMode } from './mode-policy.js'
import {
  migrationItemApplySchema, migrationPlanCreateSchema, createMigrationPlan, getMigrationPlan, listMigrationPlans,
  prepareMigrationItem, getMigrationItemReview, applyMigrationItem, setMigrationPlanState,
} from './migration-service.js'

function actor(context: ToolContext) {
  if (!context.workspaceId || !context.workspaceActorUserId || context.systemRead || context.programmaticPrincipal) {
    throw new WorkspaceAccessError('admin_required')
  }
  return { workspaceId: context.workspaceId, userId: context.workspaceActorUserId }
}
function failure(error: unknown) {
  return { isError: true as const, data: { error: error instanceof WorkspaceAccessError ? error.code : 'workspace_migration_unavailable' } }
}
const item = z.object({ planId: z.string().uuid(), itemId: z.string().uuid() }).strict()
const application = item.extend({ confirmation: migrationItemApplySchema }).strict()
const management = z.object({ planId: z.string().uuid(), state: z.enum(['paused', 'cancelled', 'proposed']) }).strict()

/** Attended orchestration over canonical reviews; never an unattended admin agent. */
export function createWorkspaceMigrationTools(): Tool[] {
  return [buildTool({
    name: 'inspectWorkspaceMigration',
    description: 'Inspect workspace access mode and administrator migration progress. A saved plan is a proposal, not authority or proof of complete migration. Read blockers and per-item outcomes. With planId and inventory.family, browse saved metadata (after paginates). Set inventory.reconcile=true to checkpoint at most 50 live changes; repeat until quiet, then repeat families to discover a new tail. Quiet is never final certification. This tool does not activate Simple or strict classification. Requires the verified human; administrators alone can inspect migration plans.',
    inputSchema: z.object({ planId: z.string().uuid().optional(), after: z.string().uuid().optional(), inventory: migrationInventoryPageInput.extend({reconcile:z.boolean().optional()}).optional() }).strict().refine(value => !(value.planId && value.after) && (!value.inventory || !!value.planId)),
    isReadOnly: true, isConcurrencySafe: false,
    async execute(input, context) {
      try {
        const p = actor(context)
        if(input.inventory && input.planId){
          const {reconcile,...page}=input.inventory
          return {data:reconcile
            ? await inspectMigrationInventory(p.workspaceId,p.userId,input.planId,{family:page.family})
            : await getMigrationInventory(p.workspaceId,p.userId,input.planId,page)}
        }
        const mode = await getWorkspaceAccessMode(p.workspaceId, p.userId)
        return { data: { mode, ...(input.planId
          ? { plan: await getMigrationPlan(p.workspaceId, p.userId, input.planId) }
          : { plans: await listMigrationPlans(p.workspaceId, p.userId, input.after) }) } }
      } catch (error) { return failure(error) }
    },
  }), buildTool({
    name: 'prepareWorkspaceMigration',
    description: 'Prepare a durable, read/edit impact preview for up to 25 explicit member, assistant, or single-root resource scope changes. Use inspected IDs and preserve clearance/roles. The target mode expresses intent only: this bounded preview does not certify resource/connector/job coverage or activate a mode. Save the returned plan and item IDs; review and confirm each item separately. Retry with the exact idempotency key and unchanged intent. No access changes occur while preparing.',
    inputSchema: migrationPlanCreateSchema,
    isReadOnly: false, isConcurrencySafe: false,
    async execute(input, context) {
      try {
        const p = actor(context), plan = await createMigrationPlan(p.workspaceId, p.userId, input)
        return { data: await getMigrationPlan(p.workspaceId, p.userId, plan.id) }
      } catch (error) { return failure(error) }
    },
  }), buildTool({
    name: 'reviewWorkspaceMigrationItem',
    description: 'Refresh the proposed before/after effect and prepare one expiring canonical review for a saved migration item. Returns the exact review ID/hash required by applyWorkspaceMigrationItem. No authority is changed here. Changes to policy or dependencies require another review, never automatic approval.',
    inputSchema: item, isReadOnly: false, isConcurrencySafe: false,
    async execute(input, context) {
      try {
        const p = actor(context)
        return { data: await prepareMigrationItem(p.workspaceId, p.userId, input.planId, input.itemId) }
      } catch (error) { return failure(error) }
    },
  }), buildTool({
    name: 'applyWorkspaceMigrationItem',
    description: 'Apply exactly one saved, explicitly confirmed migration item. Supply its immutable canonical review ID and payload hash (for resources also the returned kind, expectedVersion and expiresAt) from reviewWorkspaceMigrationItem. Applied changes take effect immediately; pausing/cancelling does not undo them. Retry returns a receipt and cannot apply a different item. Does not activate workspace mode or strict classification, and never auto-expands rights to repair blocked work.',
    inputSchema: application, isReadOnly: false, isConcurrencySafe: false,
    requiresConfirmation: true, allowPersistentApproval: false,
    async describeConfirmation(input, context) {
      const p = actor(context), parsed = application.parse(input)
      const review = await getMigrationItemReview(p.workspaceId, p.userId, parsed.planId, parsed.itemId, parsed.confirmation)
      if (review.alreadyApplied) return ['This exact item is already applied. Continuing retrieves its receipt; it does not repeat the change.']
      if('kind' in review){
        const r=review.review
        return [`${r.action}: ${r.resourceKind} ${r.items[0].resourceId}`,`Reason: ${r.reason}`,
          `Target department: ${r.targetTeamId??'none'}`,`Impact: ${JSON.stringify(r.items[0].impact)}`,
          'Read and edit are distinct. Collaboration grants do not grant edit. Private ownership, sensitivity, Projects and assistant ceilings still restrict access.',
          `Review expires: ${review.expiresAt}`, 'Immediate change; cancellation does not undo applied work. Full mode migration remains blocked.']
      }
      return [review.command.type, ...review.changes.map(change => `${change.field}: ${change.before.map(value => value.value).join(', ')} → ${change.after.map(value => value.value).join(', ')}`),
        `Review expires: ${review.expiresAt}`, 'This change takes effect immediately. Cancellation stops future batches, not changes already applied. Other source, connector and job blockers still need review.']
    },
    async execute(input, context) {
      try {
        const p = actor(context)
        return { data: await applyMigrationItem(p.workspaceId, p.userId, input.planId, input.itemId, input.confirmation) }
      } catch (error) { return failure(error) }
    },
  }), buildTool({
    name: 'manageWorkspaceMigration',
    description: 'Pause, cancel, or resume proposing a saved migration. This does not roll back applied changes or approve remaining work. Outstanding reviews are permanently invalidated when stopped; applied receipts remain replayable.',
    inputSchema: management,
    isReadOnly: false, isConcurrencySafe: false, requiresConfirmation: true, allowPersistentApproval: false,
    async describeConfirmation(input, context) {
      const p = actor(context), parsed = management.parse(input), plan = await getMigrationPlan(p.workspaceId, p.userId, parsed.planId)
      return [`Migration ${plan.id}: ${parsed.state}`, 'Applied changes remain in effect. Resuming does not approve any new item.']
    },
    async execute(input, context) {
      try {
        const p = actor(context)
        return { data: await setMigrationPlanState(p.workspaceId, p.userId, input.planId, input.state) }
      } catch (error) { return failure(error) }
    },
  })]
}
