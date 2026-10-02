/**
 * Pending-setup protocol, NOT a provider isolation certification. Production
 * admission and authenticated transports live in transactional-setup and the
 * setup routers. Simple catalog exceptions remain deliberately unsupported.
 *
 * Dependencies are trusted server code, never HTTP-supplied assertions. Admission
 * must resolve ownership and canonical context; lockAndValidate must lock exact
 * targets AND all relevant authority rows, compare generations/versions, and
 * check credential-owner authority (including every retained exposure). All
 * competing writers must take compatible locks; SQL629 rejects resource-first
 * legacy writers on workspace-lock contention instead of waiting backwards.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { decryptCredentials, encryptCredentials } from '../db/credential-crypto.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'
import { ConnectorSetupLockRetry } from './setup-locks.js'

export type SetupIntent = {
  operation: 'create' | 'reconnect' | 'share' | 'transfer' | 'rebind'
  surface: string
  ownership: 'personal' | 'workspace'
  credentialOwnerId: string
  target: null | { instanceId: string; version: string; grants: { id: string; version: string }[] }
  binding: { departments: string[]; projects: string[]; origin: string; sensitivityFloor: string }
  importDestination: string | null
  ingestionOptIn: boolean
  authorityReferences: string[]
  boundaryProposal: string
  /** Non-secret correlation/hash only; never a cookie, OAuth code or PKCE verifier. */
  sessionBinding: string
  redirectIdentity: string
}
export type SetupContext = {
  id: string; actorId: string; workspaceId: string | null; provider: string
  policyRevision: string | null; intent: SetupIntent
}
export type VerifiedAccount = {
  subject: string; tenant: string | null; roots: string[]; permissions: string[]
  adapter: string; adapterVersion: string
}
export type ActivationResult = { instanceId: string; grantIds: string[]; outboxIds: string[] }
export type SetupStatus = 'pending_auth' | 'pending_review' | 'ready' | 'active' | 'stale' | 'failed' | 'cancelled' | 'expired'
type Row = {
  id: string; actor_user_id: string; workspace_id: string | null; provider: string
  policy_revision: string | null; intent: SetupIntent; status: SetupStatus; version: string
  nonce_hash: string | null; consent_digest: string | null; saved_consent_digest: string | null
  result_ids: ActivationResult | null; expires_at: Date
}
export class ConnectorSetupError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'ConnectorSetupError' }
}
function fail(code: string): never { throw new ConnectorSetupError(code) }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value)
}
const context = (r: Row): SetupContext => ({ id: r.id, actorId: r.actor_user_id, workspaceId: r.workspace_id,
  provider: r.provider, policyRevision: r.policy_revision, intent: r.intent })
// Deliberately not spreading database rows; administrators never get account/root evidence.
const projection = (r: Row) => ({ id: r.id, provider: r.provider, workspaceId: r.workspace_id,
  status: r.status, version: r.version, expiresAt: r.expires_at, result: r.result_ids })

export function createConnectorSetupService<Request, Proof, Credentials>(options: {
  pool: Pool
  encryptionKey: Buffer
  /** Secret pre-auth material; encrypted separately and excluded from intent/review. */
  startMaterial?: (request: Request) => unknown
  validateStage?: boolean
  /** Current original-session/authority lifetime, queried on the same locked transaction. */
  authorityValidForMs?: (client: PoolClient, setup: SetupContext) => Promise<number>
  /** Last check after ALL publication/receipt writes. Must include setup and
   * original-session clock expiry; cannot compare pre-write target versions. */
  validateCommit?: (client: PoolClient, setup: SetupContext, expiresAt: Date) => Promise<boolean>
  admit: (client: PoolClient, actorId: string, request: Request) => Promise<{
    workspaceId: string | null; provider: string; intent: SetupIntent
  }>
  /** Acquire the complete workspace set before policy, setup or resource locks. */
  lockWorkspaces?: (client: PoolClient, setup: SetupContext) => Promise<void>
  /** Runs at start and activation; false permanently stales activation. Must acquire locks. */
  lockAndValidate: (client: PoolClient, setup: SetupContext) => Promise<boolean>
  /** Only this injected adapter produces evidence. Do not implement as identity(input).
   * It must verify authenticated provider responses and session/redirect/PKCE binding.
   * Called after durable nonce consumption, outside the database transaction. */
  verifyProvider: (setup: SetupContext, proof: Proof, callback: { state: string }, material?: unknown) => Promise<{ credentials: Credentials; account: VerifiedAccount }>
  /** Writes credentials/exact binding/grants/audit/outbox on THIS client only.
   * No network effects, no nested transaction, no default unbounded connector. */
  activate: (client: PoolClient, setup: SetupContext, verified: {
    credentials: Credentials; account: VerifiedAccount
  }) => Promise<ActivationResult>
}) {
  if (options.encryptionKey.length !== 32) fail('connector_setup_key_required')
  const key = Buffer.from(options.encryptionKey)
  // Crashes after nonce claim are fail-closed: restart setup or cancel/expire;
  // never re-exchange an authorization code whose outcome is uncertain.
  async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const c = await options.pool.connect()
      try {
        await c.query('BEGIN')
        await c.query("SELECT set_config('app.system_bypass','true',true)")
        const result = await fn(c)
        await c.query('COMMIT')
        return result
      } catch (error) {
        await c.query('ROLLBACK')
        // Only a pre-effect discovery restart is automatic. Provider exchanges
        // are outside tx and are never repeated by this loop.
        if (error instanceof ConnectorSetupLockRetry) {
          if (attempt < 3) continue
          throw new ConnectorSetupError('connector_setup_concurrent_change')
        }
        // Never propagate provider errors, SQL parameters or credentials.
        if (error instanceof ConnectorSetupError) throw error
        if (error instanceof WorkspaceAccessError) throw new ConnectorSetupError(error.code)
        throw new ConnectorSetupError('connector_setup_failed')
      } finally { c.release() }
    }
  }
  async function policy(c: PoolClient, workspaceId: string | null, actorId: string) {
    if (!workspaceId) return null
    await c.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])
    const p = await c.query('SELECT revision FROM workspace_access_policies WHERE workspace_id=$1 FOR UPDATE', [workspaceId])
    const m = await c.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE', [workspaceId, actorId])
    if (!p.rowCount || !m.rowCount) return undefined
    return String(p.rows[0].revision)
  }
  async function locked(c: PoolClient, actorId: string, id: string) {
    if (options.lockWorkspaces) {
      const hint = (await c.query<Row>('SELECT * FROM connector_pending_setups WHERE id=$1 AND actor_user_id=$2', [id, actorId])).rows[0]
      if (!hint) fail('connector_setup_not_found')
      await options.lockWorkspaces(c, context(hint))
    }
    const r = (await c.query<Row>('SELECT * FROM connector_pending_setups WHERE id=$1 FOR UPDATE', [id])).rows[0]
    if (!r || r.actor_user_id !== actorId) fail('connector_setup_not_found')
    return r
  }
  async function terminal(c: PoolClient, r: Row, status: SetupStatus) {
    await c.query('DELETE FROM connector_setup_staged_credentials WHERE setup_id=$1', [r.id])
    await c.query('DELETE FROM connector_setup_auth_material WHERE setup_id=$1', [r.id])
    await c.query('UPDATE connector_pending_setups SET status=$2,nonce_hash=NULL,consent_digest=NULL,saved_consent_digest=NULL WHERE id=$1', [r.id, status])
    r.status = status; r.version = String(BigInt(r.version) + 1n)
    r.nonce_hash = null; r.consent_digest = null; r.saved_consent_digest = null
  }
  async function expired(c: PoolClient, r: Row) {
    if (!['pending_auth', 'pending_review', 'ready'].includes(r.status)) return false
    const { rows } = await c.query('SELECT clock_timestamp() >= $1::timestamptz AS expired', [r.expires_at])
    if (!rows[0].expired) return false
    await terminal(c, r, 'expired'); return true
  }
  async function payload(c: PoolClient, r: Row) {
    const b = (await c.query('SELECT encrypted_payload FROM connector_setup_staged_credentials WHERE setup_id=$1', [r.id])).rows[0]
    if (!b) fail('connector_setup_credentials_missing')
    return decryptCredentials<{ credentials: Credentials; account: VerifiedAccount }>(b.encrypted_payload, key)
  }
  async function liveOwner(c: PoolClient, r: Row) {
    if (r.workspace_id && !(await c.query('SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [r.workspace_id, r.actor_user_id])).rowCount) fail('connector_setup_not_found')
  }
  return {
    async start(actorId: string, request: Request, ttlSeconds = 600) {
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 1800) fail('connector_setup_expiry_invalid')
      return tx(async c => {
        const admitted = await options.admit(c, actorId, request)
        // Clone server admission: caller mutation cannot change the saved intent.
        const intent: SetupIntent = JSON.parse(JSON.stringify(admitted.intent))
        if ((intent.operation === 'create') !== (intent.target === null)
          || !intent.binding || !Array.isArray(intent.binding.departments) || !Array.isArray(intent.binding.projects)
          || !intent.binding.origin || !intent.binding.sensitivityFloor
          || (intent.target !== null && (!intent.target.instanceId || !intent.target.version
            || !Array.isArray(intent.target.grants) || intent.target.grants.some(g => !g.id || !g.version)))
          || !intent.credentialOwnerId || !intent.sessionBinding || !intent.redirectIdentity
          || (intent.ownership === 'workspace' && !admitted.workspaceId)) fail('connector_setup_intent_invalid')
        const revision = await policy(c, admitted.workspaceId, actorId)
        if (revision === undefined) fail('connector_setup_forbidden')
        const id = randomUUID(), nonce = randomBytes(32).toString('base64url')
        const setup: SetupContext = { id, actorId, workspaceId: admitted.workspaceId, provider: admitted.provider, intent, policyRevision: revision }
        if (!await options.lockAndValidate(c, setup)) fail('connector_setup_forbidden')
        const r = (await c.query<Row>(`INSERT INTO connector_pending_setups
          (id,actor_user_id,workspace_id,provider,intent,policy_revision,nonce_hash,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+$8*interval '1 second') RETURNING *`,
        [id, actorId, admitted.workspaceId, admitted.provider, intent, revision, hash(nonce), ttlSeconds])).rows[0]!
        const material = options.startMaterial?.(request)
        if (material !== undefined) await c.query('INSERT INTO connector_setup_auth_material VALUES($1,$2)', [id, encryptCredentials(material, key)])
        return { ...projection(r), nonce }
      })
    },
    async stageVerifiedCredentials(actorId: string, id: string, nonce: string, proof: Proof,
      binding?: { sessionId: string; provider?: string; workspaceId?: string }) {
      const claim = await tx(async c => {
        const r = await locked(c, actorId, id)
        await liveOwner(c, r)
        if (binding && (binding.sessionId !== r.intent.sessionBinding
          || (binding.provider !== undefined && binding.provider !== r.provider)
          || (binding.workspaceId !== undefined && binding.workspaceId !== r.workspace_id))) fail('connector_setup_binding_mismatch')
        if (await expired(c, r)) return { row: r, claimed: false, material: undefined }
        if (options.validateStage && ((await policy(c, r.workspace_id, actorId)) !== r.policy_revision || !await options.lockAndValidate(c, context(r)))) {
          if (r.status === 'pending_auth') await terminal(c, r, 'stale')
          return { row: r, claimed: false, material: undefined }
        }
        if (r.status !== 'pending_auth' || r.nonce_hash !== hash(nonce)) fail('connector_setup_nonce_invalid')
        await c.query('UPDATE connector_pending_setups SET nonce_hash=NULL WHERE id=$1', [id])
        r.version = String(BigInt(r.version) + 1n)
        const stored = (await c.query('SELECT encrypted_payload FROM connector_setup_auth_material WHERE setup_id=$1', [id])).rows[0]
        return { row: r, claimed: true, material: stored ? decryptCredentials<unknown>(stored.encrypted_payload, key) : undefined }
      })
      if (!claim.claimed) return projection(claim.row)
      let verified: { credentials: Credentials; account: VerifiedAccount } | undefined
      try {
        const result = await options.verifyProvider(context(claim.row), proof, { state: `${id}.${nonce}` }, claim.material)
        const a = result.account
        if (!a.subject || !a.adapter || !a.adapterVersion || !Array.isArray(a.roots) || !Array.isArray(a.permissions)) fail('connector_setup_evidence_invalid')
        verified = { credentials: result.credentials, account: { subject: a.subject, tenant: a.tenant,
          roots: [...new Set(a.roots)].sort(), permissions: [...new Set(a.permissions)].sort(), adapter: a.adapter, adapterVersion: a.adapterVersion } }
      } catch { /* Persist only a fixed status, never provider errors. */ }
      return tx(async c => {
        const r = await locked(c, actorId, id)
        if (await expired(c, r) || r.status !== 'pending_auth') return projection(r)
        if (options.validateStage && ((await policy(c, r.workspace_id, actorId)) !== r.policy_revision || !await options.lockAndValidate(c, context(r)))) {
          await terminal(c, r, 'stale'); return projection(r)
        }
        if (!verified) { await terminal(c, r, 'failed'); return projection(r) }
        await liveOwner(c, r)
        await c.query('DELETE FROM connector_setup_auth_material WHERE setup_id=$1', [id])
        await c.query('INSERT INTO connector_setup_staged_credentials VALUES($1,$2)', [id, encryptCredentials(verified, key)])
        await c.query("UPDATE connector_pending_setups SET status='pending_review' WHERE id=$1", [id])
        r.status = 'pending_review'; r.version = String(BigInt(r.version) + 1n)
        return projection(r)
      })
    },
    async prepareConsent(actorId: string, id: string) {
      return tx(async c => {
        const r = await locked(c, actorId, id)
        await liveOwner(c, r)
        if (await expired(c, r)) return { setup: projection(r), review: null, viewerUserId: actorId, workspaceId: r.workspace_id, policyRevision: r.policy_revision, validForMs: 0 }
        if (!['pending_review', 'ready'].includes(r.status)) fail('connector_setup_not_reviewable')
        // Membership alone is not authority to inspect private provider evidence.
        if ((await policy(c, r.workspace_id, actorId)) !== r.policy_revision || !await options.lockAndValidate(c, context(r))) {
          await terminal(c, r, 'stale')
          return { setup: projection(r), review: null, viewerUserId: actorId, workspaceId: r.workspace_id, validForMs: 0 }
        }
        const lifetime = (await c.query<{ ms: number }>(`SELECT greatest(0,least(30000,
          floor(extract(epoch FROM ($1::timestamptz-clock_timestamp()))*1000)))::integer AS ms`, [r.expires_at])).rows[0].ms
        const validForMs = Math.min(lifetime, await options.authorityValidForMs?.(c, context(r)) ?? 30000)
        if (validForMs <= 0) { await terminal(c, r, 'stale'); return { setup: projection(r), review: null, viewerUserId: actorId, workspaceId: r.workspace_id, validForMs: 0 } }
        const { account } = await payload(c, r)
        const review = { setup: context(r), account }
        const digest = hash(canonical(review))
        if (r.consent_digest !== digest) {
          await c.query('UPDATE connector_pending_setups SET consent_digest=$2 WHERE id=$1', [id, digest])
          r.version = String(BigInt(r.version) + 1n)
        }
        return { setup: projection(r), review, digest, viewerUserId: actorId, workspaceId: r.workspace_id, policyRevision: r.policy_revision, validForMs }
      })
    },
    async saveConsent(actorId: string, id: string, digest: string) {
      return tx(async c => {
        const r = await locked(c, actorId, id)
        await liveOwner(c, r)
        if (await expired(c, r)) return projection(r)
        if ((await policy(c, r.workspace_id, actorId)) !== r.policy_revision || !await options.lockAndValidate(c, context(r))) {
          if (['pending_review', 'ready'].includes(r.status)) await terminal(c, r, 'stale')
          return projection(r)
        }
        if (!['pending_review', 'ready'].includes(r.status) || !r.consent_digest || r.consent_digest !== digest) fail('connector_setup_consent_mismatch')
        await c.query("UPDATE connector_pending_setups SET saved_consent_digest=$2,status='ready' WHERE id=$1", [id, digest])
        r.status = 'ready'; r.version = String(BigInt(r.version) + 1n); return projection(r)
      })
    },
    async activate(actorId: string, id: string, digest: string) {
      return tx(async c => {
        // Workspace first, then setup, matching canonical policy lock ordering.
        const hint = (await c.query<Row>('SELECT * FROM connector_pending_setups WHERE id=$1 AND actor_user_id=$2', [id, actorId])).rows[0]
        if (!hint) fail('connector_setup_not_found')
        await options.lockWorkspaces?.(c, context(hint))
        const revision = await policy(c, hint.workspace_id, actorId)
        const r = await locked(c, actorId, id)
        if (!r.saved_consent_digest || digest !== r.saved_consent_digest) fail('connector_setup_consent_mismatch')
        if (revision === undefined) {
          if (r.status === 'ready') await terminal(c, r, 'stale')
          return { ...projection(r), result: null }
        }
        if (r.status === 'active') return projection(r) // Receipt only; never reactivates anything.
        if (await expired(c, r)) return projection(r)
        if (r.status !== 'ready' || r.consent_digest !== digest) fail('connector_setup_not_ready')
        if (revision !== r.policy_revision || !await options.lockAndValidate(c, context(r))) {
          await terminal(c, r, 'stale'); return projection(r)
        }
        const verified = await payload(c, r)
        if (hash(canonical({ setup: context(r), account: verified.account })) !== digest) fail('connector_setup_consent_mismatch')
        const result = await options.activate(c, context(r), verified)
        // Result is IDs only, not arbitrary adapter output.
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        if ((r.intent.target !== null && result.instanceId !== r.intent.target.instanceId)
          || !uuid.test(result.instanceId) || !Array.isArray(result.grantIds) || !Array.isArray(result.outboxIds)
          || ![...result.grantIds, ...result.outboxIds].every(v => uuid.test(v))) fail('connector_setup_result_invalid')
        // A slow callback must not commit an expired admission.
        if ((await c.query('SELECT clock_timestamp() >= $1::timestamptz AS expired', [r.expires_at])).rows[0].expired) fail('connector_setup_expired')
        const receipt = { instanceId: result.instanceId, grantIds: result.grantIds, outboxIds: result.outboxIds }
        await c.query("UPDATE connector_pending_setups SET status='active',result_ids=$2 WHERE id=$1", [id, receipt])
        await c.query('DELETE FROM connector_setup_staged_credentials WHERE setup_id=$1', [id])
        // Locks prevent concurrent revocation, not the passage of time. This
        // must remain after the last write, immediately before tx commits.
        if (options.validateCommit) {
          if (!await options.validateCommit(c, context(r), r.expires_at)) fail('connector_setup_authority_expired')
        } else if ((await c.query('SELECT clock_timestamp() >= $1::timestamptz AS expired', [r.expires_at])).rows[0].expired) fail('connector_setup_expired')
        r.status = 'active'; r.result_ids = receipt; r.version = String(BigInt(r.version) + 1n); return projection(r)
      })
    },
    async cancel(actorId: string, id: string) {
      return tx(async c => {
        const r = await locked(c, actorId, id)
        if (['pending_auth', 'pending_review', 'ready'].includes(r.status)) await terminal(c, r, 'cancelled')
        return projection(r)
      })
    },
    async expire() {
      return tx(async c => {
        const rows = (await c.query<Row>(`SELECT * FROM connector_pending_setups WHERE expires_at<=clock_timestamp()
          AND status IN ('pending_auth','pending_review','ready') FOR UPDATE SKIP LOCKED LIMIT 100`)).rows
        for (const r of rows) await terminal(c, r, 'expired')
        return rows.length
      })
    },
    async get(actorId: string, id: string) {
      return tx(async c => {
        const r = (await c.query<Row>('SELECT * FROM connector_pending_setups WHERE id=$1', [id])).rows[0]
        if (!r) fail('connector_setup_not_found')
        if (r.actor_user_id === actorId) await liveOwner(c, r)
        else if (!r.workspace_id || !(await c.query("SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND role IN ('owner','admin')", [r.workspace_id, actorId])).rowCount) fail('connector_setup_not_found')
        return projection(r)
      })
    },
  }
}
