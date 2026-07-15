/**
 * Email domains store — workspace-owned BYO mail domains (migration 326).
 *
 * One row per domain a workspace brings for its assistant inboxes
 * (docs/architecture/integrations/agentmail.md, decision D2). `records` is
 * the DNS instruction payload (MX/SPF/DKIM/DMARC rows) rendered by the UI
 * and refreshed on every provider verify; `provider_status` keeps the raw
 * vendor enum behind the normalized `status`.
 *
 * User-facing reads/writes are RLS-gated (workspace membership); the webhook
 * path (domain.verified) flips status system-side by provider domain id, the
 * same pre-auth posture as channel-integrations' webhook lookups.
 *
 * Component tag: [COMP:api/email-domains-store]
 */

import { query, queryWithRLS } from './client.js'

export type EmailDomainStatus = 'pending' | 'verified' | 'failed'

export type EmailDomainDnsRecord = {
  type: string
  name: string
  value: string
  status: string | null
  priority: number | null
}

export type EmailDomain = {
  id: string
  workspaceId: string
  domain: string
  providerDomainId: string | null
  status: EmailDomainStatus
  providerStatus: string | null
  records: EmailDomainDnsRecord[]
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

const COLS = `
  id, workspace_id as "workspaceId", domain,
  provider_domain_id as "providerDomainId",
  status, provider_status as "providerStatus", records,
  created_by as "createdBy",
  created_at as "createdAt", updated_at as "updatedAt"
`

export type EmailDomainStore = {
  /** Create a pending domain row. RLS-gated (workspace member). */
  create(params: {
    actingUserId: string
    workspaceId: string
    domain: string
    providerDomainId: string | null
    providerStatus: string | null
    records: EmailDomainDnsRecord[]
  }): Promise<EmailDomain>

  /** List a workspace's domains. RLS-gated. */
  listForWorkspace(actingUserId: string, workspaceId: string): Promise<EmailDomain[]>

  /** Fetch one row. RLS-gated; null = missing or not authorized. */
  getForUser(actingUserId: string, id: string): Promise<EmailDomain | null>

  /** Persist a verify pass's outcome. RLS-gated. */
  updateStatusForUser(params: {
    actingUserId: string
    id: string
    status: EmailDomainStatus
    providerStatus: string | null
    records: EmailDomainDnsRecord[]
  }): Promise<EmailDomain | null>

  /**
   * Flip status by provider domain id — the `domain.verified` webhook path.
   * System-level (no RLS): webhook deliveries arrive pre-auth; upstream
   * signature verification is the gate. Returns whether a row matched.
   */
  markVerifiedByProviderIdSystem(providerDomainId: string): Promise<boolean>

  /** Delete a domain row. RLS-gated. */
  deleteForUser(actingUserId: string, id: string): Promise<boolean>
}

export function createEmailDomainStore(): EmailDomainStore {
  return {
    async create(params) {
      const result = await queryWithRLS<EmailDomain>(
        params.actingUserId,
        `INSERT INTO email_domains
           (workspace_id, domain, provider_domain_id, status, provider_status, records, created_by)
         VALUES ($1, lower($2), $3, 'pending', $4, $5, $6)
         RETURNING ${COLS}`,
        [
          params.workspaceId,
          params.domain,
          params.providerDomainId,
          params.providerStatus,
          JSON.stringify(params.records),
          params.actingUserId,
        ],
      )
      return result.rows[0]
    },

    async listForWorkspace(actingUserId, workspaceId) {
      const result = await queryWithRLS<EmailDomain>(
        actingUserId,
        `SELECT ${COLS} FROM email_domains WHERE workspace_id = $1 ORDER BY created_at ASC`,
        [workspaceId],
      )
      return result.rows
    },

    async getForUser(actingUserId, id) {
      const result = await queryWithRLS<EmailDomain>(
        actingUserId,
        `SELECT ${COLS} FROM email_domains WHERE id = $1 LIMIT 1`,
        [id],
      )
      return result.rows[0] ?? null
    },

    async updateStatusForUser(params) {
      const result = await queryWithRLS<EmailDomain>(
        params.actingUserId,
        `UPDATE email_domains
         SET status = $2, provider_status = $3, records = $4, updated_at = now()
         WHERE id = $1
         RETURNING ${COLS}`,
        [params.id, params.status, params.providerStatus, JSON.stringify(params.records)],
      )
      return result.rows[0] ?? null
    },

    async markVerifiedByProviderIdSystem(providerDomainId) {
      const result = await query(
        `UPDATE email_domains
         SET status = 'verified', provider_status = 'VERIFIED', updated_at = now()
         WHERE provider_domain_id = $1`,
        [providerDomainId],
      )
      return (result.rowCount ?? 0) > 0
    },

    async deleteForUser(actingUserId, id) {
      const result = await queryWithRLS(
        actingUserId,
        `DELETE FROM email_domains WHERE id = $1`,
        [id],
      )
      return (result.rowCount ?? 0) > 0
    },
  }
}
