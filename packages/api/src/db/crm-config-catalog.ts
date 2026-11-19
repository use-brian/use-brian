/** Pure CRM configuration discovery, shared by member and scoped machine reads.
 * Callers authenticate before reaching this workspace-qualified query.
 * [COMP:api/crm-config-catalog]
 */
import { z } from 'zod'
import { CrmPageQuerySchema } from '@use-brian/core/crm/pagination.js'
import { query } from './client.js'
import { queryCrmPage } from '../crm-operations/pagination.js'

export const CrmRecordFieldsQuerySchema = CrmPageQuerySchema.extend({
  entityKind: z.enum(['person', 'company', 'deal']).optional(),
  includeArchived: z.enum(['true', 'false']).optional(),
}).strict()

export const CrmPipelinesQuerySchema = CrmPageQuerySchema.extend({
  entityKind: z.literal('deal').default('deal'),
  includeArchived: z.enum(['true', 'false']).optional(),
}).strict()

export function readCrmFieldCatalog(workspaceId: string, raw: unknown = {}, run: Parameters<typeof queryCrmPage>[0] = query) {
  const input = CrmRecordFieldsQuerySchema.parse(raw)
  return queryCrmPage(run, { workspaceId, resource: 'crm.record-fields', key: 'fields',
    query: { limit: input.limit, cursor: input.cursor, createdAfter: input.createdAfter, createdBefore: input.createdBefore },
    sql: `SELECT id,entity_kind AS "entityKind",field_key AS "fieldKey",label,
      field_type AS "fieldType",options,is_required AS "isRequired",position,
      archived_at AS "archivedAt",created_at AS "createdAt",updated_at AS "updatedAt"
      FROM crm_field_definitions WHERE workspace_id=$1
        AND ($2::text IS NULL OR entity_kind=$2) AND ($3::boolean OR archived_at IS NULL)`,
    params: [workspaceId, input.entityKind ?? null, input.includeArchived === 'true'] })
}
