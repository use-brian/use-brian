/**
 * Compartment axis — config-layer store. Backs the admin surface that POPULATES
 * the enforcing columns (mig 243): the `workspace_compartments` registry (the
 * named taxonomy + the picker source) and the grant setters that write
 * `assistants.compartments`/`default_compartments` + `workspace_members.compartments`
 * (with a `member_compartment_grants` audit append). The read-gate predicate
 * never consults the registry — it reads the array columns — so validation here
 * is a UX/integrity guard, not a security gate. See docs/plans/compartment-axis.md.
 *
 * Reads/writes are `queryWithRLS`-gated (admin-write / member-read via the
 * migration-246 policies); a `null` insert result means RLS rejected the caller.
 */
import { query, queryWithRLS, getPool, rollbackAndRelease } from './client.js'

// Same shape as the other db stores (entities-store, mark-useful-store, …).
// Used to validate any id that reaches a session GUC via string interpolation.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type CompartmentRegistryEntry = {
  id: string
  workspaceId: string
  key: string
  label: string
  description: string | null
  color: string | null
}

const REG_COLS = `
  id,
  workspace_id AS "workspaceId",
  key,
  label,
  description,
  color
`

export type CompartmentStore = ReturnType<typeof createDbCompartmentStore>

export function createDbCompartmentStore() {
  return {
    /** The registered keys for a workspace (system-level; used for grant validation). */
    async registeredKeysSystem(workspaceId: string): Promise<Set<string>> {
      const r = await query<{ key: string }>(
        `SELECT key FROM workspace_compartments WHERE workspace_id = $1`,
        [workspaceId],
      )
      return new Set(r.rows.map((row) => row.key))
    },

    async list(actingUserId: string, workspaceId: string): Promise<CompartmentRegistryEntry[]> {
      const r = await queryWithRLS<CompartmentRegistryEntry>(
        actingUserId,
        `SELECT ${REG_COLS} FROM workspace_compartments WHERE workspace_id = $1 ORDER BY key ASC`,
        [workspaceId],
      )
      return r.rows
    },

    /** Returns null when RLS rejects (caller is not owner/admin). Throws 23505 on duplicate key. */
    async create(
      actingUserId: string,
      params: { workspaceId: string; key: string; label: string; description?: string | null; color?: string | null },
    ): Promise<CompartmentRegistryEntry | null> {
      const r = await queryWithRLS<CompartmentRegistryEntry>(
        actingUserId,
        `INSERT INTO workspace_compartments (workspace_id, key, label, description, color, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${REG_COLS}`,
        [params.workspaceId, params.key, params.label, params.description ?? null, params.color ?? null, actingUserId],
      )
      return r.rows[0] ?? null
    },

    /** Delete a registry entry. Does NOT scrub the key from existing row/grant arrays (forward-only). */
    async remove(actingUserId: string, workspaceId: string, key: string): Promise<boolean> {
      const r = await queryWithRLS<{ id: string }>(
        actingUserId,
        `DELETE FROM workspace_compartments WHERE workspace_id = $1 AND key = $2 RETURNING id`,
        [workspaceId, key],
      )
      return r.rows.length > 0
    },

    /**
     * Set an assistant's compartment grant + write-stamp default. `null` grant =
     * universe. `defaultCompartments` must be ⊆ `compartments` (enforced by the
     * route before calling). RLS-gated to workspace admins (the assistant's
     * workspace membership policy). Returns false when the assistant isn't found
     * or RLS rejects.
     */
    async setAssistantGrant(
      actingUserId: string,
      assistantId: string,
      compartments: string[] | null,
      defaultCompartments: string[],
    ): Promise<boolean> {
      const r = await queryWithRLS<{ id: string }>(
        actingUserId,
        `UPDATE assistants SET compartments = $2, default_compartments = $3 WHERE id = $1 RETURNING id`,
        [assistantId, compartments, defaultCompartments],
      )
      return r.rows.length > 0
    },

    /**
     * Set a member's compartment grant (`workspace_members.compartments`) and
     * append a `member_compartment_grants` audit row per added/removed key.
     * `null`/empty newGrant clears the grant. System-level write (the route
     * does the admin gate) so the audit + column move together.
     */
    async setMemberGrant(
      grantorUserId: string,
      workspaceId: string,
      granteeUserId: string,
      newGrant: string[] | null,
    ): Promise<boolean> {
      // Defense-in-depth: the route admin-gates this; validate the grantor id is
      // a UUID before it reaches the audit insert below.
      if (!UUID_RE.test(grantorUserId)) {
        throw new Error('setMemberGrant: grantorUserId must be a UUID')
      }
      // SYSTEM operation: this manages ANOTHER member's (the grantee's) row + the
      // audit trail, which the per-user RLS (`wm_own_workspace`: user_id =
      // current_user_id) would hide from the acting admin. Authorization is the
      // route's admin gate, not RLS — so it runs on the system pool (owner role),
      // which bypasses RLS. `grantorUserId` is recorded as a value in the audit.
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        const prior = await client.query<{ compartments: string[] | null }>(
          `SELECT compartments FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
          [workspaceId, granteeUserId],
        )
        if (prior.rows.length === 0) {
          await client.query('ROLLBACK')
          return false
        }
        const before = new Set(prior.rows[0].compartments ?? [])
        const after = new Set(newGrant ?? [])
        await client.query(
          `UPDATE workspace_members SET compartments = $3 WHERE workspace_id = $1 AND user_id = $2`,
          [workspaceId, granteeUserId, newGrant],
        )
        const audits: { key: string; action: 'granted' | 'revoked' }[] = []
        for (const k of after) if (!before.has(k)) audits.push({ key: k, action: 'granted' })
        for (const k of before) if (!after.has(k)) audits.push({ key: k, action: 'revoked' })
        for (const a of audits) {
          await client.query(
            `INSERT INTO member_compartment_grants
               (workspace_id, grantee_user_id, compartment_key, action, grantor_user_id)
             VALUES ($1, $2, $3, $4, $5)`,
            [workspaceId, granteeUserId, a.key, a.action, grantorUserId],
          )
        }
        await client.query('COMMIT')
        return true
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        await rollbackAndRelease(client)
      }
    },
  }
}
