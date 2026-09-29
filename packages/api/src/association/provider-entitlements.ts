/** Compatibility composition for callers that have not supplied a command port. */
import type { Pool } from 'pg'
import { createDbCrmOperationsStore } from '../db/crm-operations-store.js'
import { createCrmOperationsService } from '../crm-operations/service.js'
import { createProviderEntitlementService } from './provider-entitlement-service.js'

export { createProviderEntitlementService }
export type { ProviderEntitlementServiceOptions, ProviderEntitlementServicePort } from './provider-entitlement-service.js'

export function createProviderEntitlementInbox(pool: Pool) {
  return createProviderEntitlementService({
    pool,
    operationsForTransaction: (client) => createCrmOperationsService(createDbCrmOperationsStore(pool, client)),
  })
}
