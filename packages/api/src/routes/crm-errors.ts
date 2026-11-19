/** Shared CRM HTTP error mapping. [COMP:api/crm-integration-auth] */
import type { Response } from 'express'
import { z } from 'zod'
import { WorkspaceModuleError } from '@use-brian/shared'
import { CrmIntegrationScopeError } from '@use-brian/core/crm/integration-authority.js'
import { CrmOperationsError } from '@use-brian/core/crm/operations-types.js'
import { AssociationError } from '../association/domain.js'

export function crmErrorResponse(error: unknown, res: Response): void {
  if ((error as { code?: string } | null)?.code === 'scope_operation_denied') {
    res.status(403).json({ error: 'scope_operation_denied',
      message: 'This operation is unavailable in your current scope. Ask a workspace administrator to review access.' })
    return
  }
  if (error instanceof CrmIntegrationScopeError) {
    res.status(403).json({ error: error.code, message: error.message, ...('details' in error ? { details: error.details } : {}) }); return
  }
  if (error instanceof z.ZodError) { res.status(400).json({ error: 'invalid_input', issues: error.issues.slice(0, 10) }); return }
  if (error instanceof WorkspaceModuleError) {
    const status = error.code === 'not_authorized' ? 403 : error.code === 'not_found' ? 404
      : error.code === 'invalid_input' ? 422 : 409
    res.status(status).json({ error: error.code, message: error.message, details: error.details })
    return
  }
  if (error instanceof CrmOperationsError) {
    const status = error.code === 'credential_revoked' ? 401 : error.code === 'not_found' ? 404
      : error.code === 'conflict' || error.code === 'idempotency_conflict' ? 409
        : error.code === 'not_authorized' ? 403 : 422
    res.status(status).json({ error: error.code, message: error.message, details: error.details })
    return
  }
  if (error instanceof AssociationError) {
    const status = error.code === 'not_found' ? 404
      : error.code === 'conflict' || error.code === 'invalid_transition' ? 409
        : 422
    res.status(status).json({ error: error.code, message: error.message, details: error.details })
    return
  }
  console.error('[crm] request failed')
  res.status(500).json({ error: 'crm_request_failed' })
}

