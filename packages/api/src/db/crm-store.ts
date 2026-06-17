import type { CrmStore, EntityLinksStore } from '@sidanclaw/core'
import {
  createCompany, getCompanyById, listCompanies, updateCompany,
  createContact, getContactById, listContacts, updateContact,
  createDeal, getDealById, listDeals, updateDeal, setDealStage,
  batchLabels,
} from './crm.js'

/**
 * Create a CrmStore backed by PostgreSQL.
 * Adapts the SQL helpers in `crm.ts` to the core `CrmStore` interface.
 *
 * All operations route through `queryWithRLS(userId, ...)` so the
 * `*_workspace_member` RLS policies enforce workspace isolation. The SQL
 * also filters by `workspace_id` explicitly — RLS is the second layer of
 * defense.
 *
 * WU-1.7 — the optional `entityLinks` dependency wires the edge-write
 * hooks: `createContact` / `createDeal` emit `works_at` / `engagement_of`
 * edges fire-and-forget when they carry a `companyId`. The dependency is
 * optional so callers that don't need the graph layer (or construct the
 * store before `entityLinks` exists) keep working — edges are simply not
 * emitted in that case. The returned `CrmStore` interface is unchanged.
 */
export function createDbCrmStore(deps: { entityLinks?: EntityLinksStore } = {}): CrmStore {
  const { entityLinks } = deps
  return {
    // Companies
    createCompany({ userId, ...params }) {
      return createCompany(userId, params)
    },
    getCompanyById(ctx, id) {
      return getCompanyById(ctx, id)
    },
    listCompanies(ctx, filters) {
      return listCompanies(ctx, filters)
    },
    updateCompany(userId, id, fields) {
      return updateCompany(userId, id, fields)
    },

    // Contacts
    createContact({ userId, ...params }) {
      return createContact(userId, params, entityLinks)
    },
    getContactById(ctx, id) {
      return getContactById(ctx, id)
    },
    listContacts(ctx, filters) {
      return listContacts(ctx, filters)
    },
    updateContact(userId, id, fields) {
      return updateContact(userId, id, fields, entityLinks)
    },

    // Deals
    createDeal({ userId, ...params }) {
      return createDeal(userId, params, entityLinks)
    },
    getDealById(ctx, id) {
      return getDealById(ctx, id)
    },
    listDeals(ctx, filters) {
      return listDeals(ctx, filters)
    },
    updateDeal(userId, id, fields) {
      return updateDeal(userId, id, fields, entityLinks)
    },
    setDealStage(userId, id, stage) {
      return setDealStage(userId, id, stage)
    },

    // Batch label resolution (Phase 1 — Notion-feel relation cells).
    batchLabels(ctx, requests) {
      return batchLabels(ctx, requests)
    },
  }
}
