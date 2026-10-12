export {
  DEAL_STAGES,
  type DealStage,
  type CrmExternalRef,
  CRM_CUSTOM_FIELD_TYPES,
  type CrmCustomFieldType,
  type CrmCustomFieldEntityKind,
  type CrmCustomFieldDefinition,
  type CrmCustomFieldWriteResult,
  type CompanyRecord,
  type CompanyListRow,
  type CompanyListFilters,
  type CompanyUpdateFields,
  type ContactRecord,
  type ContactListRow,
  type ContactListFilters,
  type ContactUpdateFields,
  type DealRecord,
  type DealListRow,
  type DealListFilters,
  type DealUpdateFields,
  type CrmStore,
} from './types.js'
export {
  createCrmTools,
  type CrmToolEvent,
  type CrmToolOptions,
} from './tools.js'
export {
  createCrmEmailDraftTools,
  buildEmailDraftAnchorPrompt,
  formatActiveEmailDraftContext,
  type CrmEmailDraft,
  type CrmEmailDraftStatus,
  type CrmEmailDraftStore,
} from './email-drafts.js'
export * from './operations-types.js'
export * from './submission-attachments.js'
export * from './config-commands.js'
export * from './integration-authority.js'
export * from './business-references.js'
export { createCrmBusinessReferenceTools, type CrmBusinessReferenceTools } from './business-reference-tools.js'
export * from './commercial-context.js'
export { createCrmCommercialContextTools, type CrmCommercialContextTools } from './commercial-context-tools.js'
export * from './operations-tools.js'
export * from './pagination.js'
export * from './sendability.js'
export * from './segments.js'

export * from './segment-catalog.js'

export * from './retention-types.js'
export * from './file-cleanup-types.js'
