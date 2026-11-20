/** Shared CRM request context and historical import contracts. [COMP:api/workspace-modules] */
import { z } from 'zod'
import { CrmOperationsActorSchema, CrmOperationsAuthoritySchema } from '../crm/operations-types.js'
import type { AssociationSourceOrderImportInput, AssociationPromotionImportInput, AssociationSourceMembershipImportInput } from './domain.js'

const Id = z.string().uuid()
export const AssociationContextSchema = z.object({
  workspaceId: Id,
  actor: CrmOperationsActorSchema,
  authority: CrmOperationsAuthoritySchema.extend({
    canRead: z.boolean(), canReconcileProvider: z.boolean().default(false),
  }),
}).strict()
export type AssociationContext = z.infer<typeof AssociationContextSchema>

/** Internal port used only by the confirmed production-import service. */
export interface AssociationSourceOrderImportPort {
  importSourceOrder(
    context: AssociationContext,
    input: AssociationSourceOrderImportInput,
  ): Promise<{ record: Record<string, unknown>; created: boolean; duplicate: boolean }>
}
/** Internal port used only by the confirmed production-import service. */
export interface AssociationPromotionImportPort {
  importPromotion(
    context: AssociationContext,
    input: AssociationPromotionImportInput,
  ): Promise<{ record: Record<string, unknown>; created: boolean; duplicate: boolean }>
}
/** Internal port used only by the confirmed production-import service. */
export interface AssociationSourceMembershipImportPort {
  importSourceMembership(
    context: AssociationContext,
    input: AssociationSourceMembershipImportInput,
  ): Promise<{ record: Record<string, unknown>; created: boolean; duplicate: boolean }>
}
