import type { AccessContext, EntityRecord, ProtectedFillScope, ProtectedFillSource } from '@use-brian/core'

/** Uses the same member viewpoint and gated entity lookup as trusted CRM UI.
 * Never call a model CRM tool, log a record, or reflect source errors.
 */
export function createProtectedCrmSource(deps: {
  viewpoint: (userId: string, workspaceId: string) => Promise<AccessContext | null>
  entity: (ctx: AccessContext, id: string) => Promise<EntityRecord | null>
}) {
  async function read(scope: ProtectedFillScope, source: ProtectedFillSource): Promise<string> {
    const fail = () => { throw new Error('Protected fill unavailable') }
    try {
      if (source.kind !== 'crm' || !['name', 'email', 'phone', 'company', 'jobTitle', 'address', 'website'].includes(source.field)) return fail()
      const ctx = await deps.viewpoint(scope.userId, scope.workspaceId)
      if (!ctx) return fail()
      const entity = await deps.entity(ctx, source.entityId)
      if (!entity || entity.workspaceId !== scope.workspaceId || !['person', 'company', 'deal'].includes(entity.kind) || entity.attributes.crm_archived_at) return fail()
      let value: unknown
      if (source.field === 'name') value = entity.displayName
      else if (source.field === 'company') {
        const id = entity.attributes.company_id
        if (typeof id !== 'string') return fail()
        const company = await deps.entity(ctx, id)
        if (!company || company.workspaceId !== scope.workspaceId || company.kind !== 'company' || company.attributes.crm_archived_at) return fail()
        value = company.displayName
      } else if (source.field === 'email') {
        value = entity.attributes.email ?? (entity.kind === 'person' ? entity.canonicalId : null)
      } else {
        // Built-in attribute keys only; nested/custom field paths are not accepted.
        value = entity.attributes[source.field === 'jobTitle' ? 'job_title' : source.field]
      }
      if (typeof value !== 'string' || value.length === 0 || value.length > 16_384 || value.includes('\0')) return fail()
      return value
    } catch { return fail() }
  }
  return {
    readSource: read,
    validateSource: async (scope: ProtectedFillScope, source: ProtectedFillSource) => {
      try { await read(scope, source); return true } catch { return false }
    },
  }
}
