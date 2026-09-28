/** Transactional draft/publication authority. [COMP:crm/membership-catalogue] */
import type { Pool, PoolClient } from 'pg'
import { AssociationError, MembershipCatalogueDocumentSchema, membershipPublicationIssues, resolveMembershipCatalogue,
  type MembershipCatalogueDocument, type MembershipSite, type AssociationActor } from '@use-brian/core'
import { getPool } from './client.js'
import { saveCrmEntitlementPlanRecord } from './association-store.js'
import { lockAssociationModule, requireAssociationAdmission } from '../association/workspace-module.js'

type State = { draft_version: number; draft: MembershipCatalogueDocument | null; published_revision: number; observations: Record<string, { revision: number; observedAt: string }> }
const empty: State = { draft_version: 0, draft: null, published_revision: 0, observations: {} }
export function createMembershipCatalogueStore(pool: Pool = getPool()) {
  // Only publication is gated by the Association module: it writes plan rows that checkouts read. Drafts are website copy.
  async function transaction<T>(workspaceId: string, fn: (client: PoolClient) => Promise<T>, write = false) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      if (write) requireAssociationAdmission(await lockAssociationModule(client, workspaceId))
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('membership-catalogue:'||$1,0))", [workspaceId])
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  async function state(client: PoolClient, workspaceId: string): Promise<State> {
    return (await client.query<State>('SELECT * FROM association_membership_catalogues WHERE workspace_id=$1', [workspaceId])).rows[0] ?? empty
  }
  async function published(client: PoolClient, workspaceId: string, revision: number) {
    const row = (await client.query<{ document: MembershipCatalogueDocument }>('SELECT document FROM association_membership_catalogue_revisions WHERE workspace_id=$1 AND revision=$2', [workspaceId, revision])).rows[0]
    return row ? MembershipCatalogueDocumentSchema.parse(row.document) : null
  }
  async function audit(client: PoolClient, workspaceId: string, action: string, version: number, actor: AssociationActor) {
    await client.query(`INSERT INTO association_audit_log (workspace_id,action,subject_kind,subject_id,actor_kind,actor_credential_id,acting_user_id,metadata)
      VALUES ($1,$2,'membership_catalogue',$1,$3,$4,$5,$6)`, [workspaceId, action, actor.credentialKind, actor.credentialId, actor.actingUserId ?? null, { version }])
  }
  return {
    async draft(workspaceId: string) {
      return transaction(workspaceId, async client => {
        const row = await state(client, workspaceId)
        return { version: row.draft_version, document: row.draft, publishedRevision: row.published_revision,
          published: await published(client, workspaceId, row.published_revision), observations: row.observations,
          issues: row.draft ? membershipPublicationIssues(row.draft) : [] }
      })
    },
    async save(workspaceId: string, expectedVersion: number, raw: MembershipCatalogueDocument, actor: AssociationActor) {
      const document = MembershipCatalogueDocumentSchema.parse(raw)
      return transaction(workspaceId, async client => {
        const current = await state(client, workspaceId)
        if (current.draft_version !== expectedVersion) throw new AssociationError('conflict', 'The draft changed. Reload before saving.')
        const version = expectedVersion + 1
        await client.query(`INSERT INTO association_membership_catalogues(workspace_id,draft_version,draft) VALUES($1,$2,$3)
          ON CONFLICT(workspace_id) DO UPDATE SET draft_version=$2,draft=$3,updated_at=now()`, [workspaceId, version, document])
        await audit(client, workspaceId, 'membership_catalogue.draft_saved', version, actor)
        return { version, issues: membershipPublicationIssues(document) }
      })
    },
    async publish(workspaceId: string, expectedVersion: number, actor: AssociationActor) {
      return transaction(workspaceId, async client => {
        const current = await state(client, workspaceId)
        if (current.draft_version !== expectedVersion || !current.draft) throw new AssociationError('conflict', 'The draft changed. Preview it again before publishing.')
        if (current.published_revision === expectedVersion) return { revision: expectedVersion, synchronization: 'pending', observations: current.observations }
        const document = MembershipCatalogueDocumentSchema.parse(current.draft)
        const issues = membershipPublicationIssues(document)
        if (issues.length) throw new AssociationError('conflict', issues.join('; '))
        const previous = await published(client, workspaceId, current.published_revision)
        if (previous?.plans.some(plan => !document.plans.some(next => next.key === plan.key))) throw new AssociationError('conflict', 'Keep previously published plans for order history. Close the plan and remove its website visibility instead.');
        for (const plan of document.plans) {
          const existing = (await client.query<{ id: string; provider: string | null; provider_plan_id: string | null }>(
            'SELECT id,provider,provider_plan_id FROM association_membership_plans WHERE workspace_id=$1 AND plan_key=$2 FOR UPDATE', [workspaceId, plan.key])).rows[0]
          if (plan.planId && existing?.id !== plan.planId) throw new AssociationError('conflict', `Plan identity changed: ${plan.key}`)
          if (plan.promotionId) {
            const promotion = (await client.query<{ target_ids: string[]; target_kind: string; status: string }>('SELECT target_ids,target_kind,status FROM association_promotions WHERE workspace_id=$1 AND id=$2 FOR SHARE', [workspaceId, plan.promotionId])).rows[0]
            if (!promotion || promotion.target_kind !== 'plan' || !existing || !promotion.target_ids.includes(existing.id) || plan.billingPeriod !== 'annual') throw new AssociationError('conflict', `Select a promotion for this annual plan: ${plan.key}`)
          }
          const saved = await saveCrmEntitlementPlanRecord(client, workspaceId, {
            key: plan.key, name: plan.i18n.en.name, currency: plan.currency, feeMinor: plan.feeMinor,
            billingPeriod: plan.billingPeriod, benefits: plan.i18n.en.benefits, eligibilityNote: plan.i18n.en.eligibility,
            activeFrom: plan.activeFrom, activeTo: plan.activeTo, published: plan.availability !== 'closed' && plan.sites.length > 0,
            ...(existing?.provider && existing.provider_plan_id ? { provider: existing.provider, providerPlanId: existing.provider_plan_id } : {}),
          }, true)
          plan.planId = String(saved.record.id)
        }
        for (const removed of previous?.plans ?? []) if (!document.plans.some(plan => plan.key === removed.key)) {
          await client.query('UPDATE association_membership_plans SET published=false,updated_at=now() WHERE workspace_id=$1 AND id=$2', [workspaceId, removed.planId])
        }
        await client.query('INSERT INTO association_membership_catalogue_revisions(workspace_id,revision,document,actor) VALUES($1,$2,$3,$4)', [workspaceId, expectedVersion, document, actor])
        await client.query('UPDATE association_membership_catalogues SET published_revision=$2,draft=$3,observations=\'{}\'::jsonb,updated_at=now() WHERE workspace_id=$1', [workspaceId, expectedVersion, document])
        await audit(client, workspaceId, 'membership_catalogue.published', expectedVersion, actor)
        return { revision: expectedVersion, synchronization: 'pending', observations: {} }
      }, true)
    },
    async read(workspaceId: string, site: MembershipSite, allowedPlanIds: 'all' | readonly string[] = 'all') {
      return transaction(workspaceId, async client => {
        const row = await state(client, workspaceId)
        const document = await published(client, workspaceId, row.published_revision)
        if (!document) throw new AssociationError('not_available', 'Membership content has not been published.')
        const projection = resolveMembershipCatalogue(document, site, true)
        const plans = []
        for (const plan of projection.plans) {
          if (allowedPlanIds !== 'all' && (!plan.planId || !allowedPlanIds.includes(plan.planId))) continue
          let promotion = null
          if (plan.promotionId) {
            const offer = (await client.query(`SELECT p.id,p.name,p.discount_type,p.percentage_basis_points,p.amount_minor,p.currency,
              p.valid_from,p.valid_to,p.recurrence_mode,p.recurrence_cycles,p.max_uses,p.max_uses_per_contact FROM association_promotions p
              WHERE p.workspace_id=$1 AND p.id=$2 AND p.status='active' AND p.target_kind='plan' AND $3=ANY(p.target_ids)
                AND (p.valid_from IS NULL OR p.valid_from<=now()) AND (p.valid_to IS NULL OR p.valid_to>now())
                AND (p.max_uses IS NULL OR p.source_redeemed_uses+(SELECT count(*) FROM association_promotion_uses r
                  WHERE r.workspace_id=p.workspace_id AND r.promotion_id=p.id AND (r.state='redeemed' OR (r.state='reserved' AND r.reservation_expires_at>now())))<p.max_uses)`, [workspaceId, plan.promotionId, plan.planId])).rows[0]
            if (offer) {
              const discount = offer.discount_type === 'full' ? plan.feeMinor : offer.discount_type === 'percentage'
                ? Math.floor(plan.feeMinor * Number(offer.percentage_basis_points) / 10000)
                : offer.discount_type === 'fixed_amount' && offer.currency === plan.currency ? Math.min(plan.feeMinor, Number(offer.amount_minor)) : 0
              if (discount > 0) promotion = { id: offer.id, name: offer.name, priceHkd: (plan.feeMinor - discount) / 100,
                endsAt: offer.valid_to ? new Date(offer.valid_to).toISOString() : null, requiresCode: true,
                recurrenceMode: offer.recurrence_mode, recurrenceCycles: offer.recurrence_cycles, maxUsesPerContact: offer.max_uses_per_contact, limitedAvailability: offer.max_uses !== null }
            }
          }
          const available = plan.sites.includes(site) && (!plan.activeFrom || Date.parse(plan.activeFrom) <= Date.now()) && (!plan.activeTo || Date.parse(plan.activeTo) > Date.now())
          plans.push({ ...plan, promotionId: undefined, availability: available ? plan.availability : 'closed', promotion })
        }
        return { revision: row.published_revision, source: 'brian', site, ...projection, plans }
      })
    },
    /** Summary without the document body: what the console Home and Website overview show. */
    async status(workspaceId: string) {
      const row = (await pool.query<State & { updated_at: Date; published_at: Date | null }>(
        `SELECT c.*, r.published_at FROM association_membership_catalogues c
           LEFT JOIN association_membership_catalogue_revisions r ON r.workspace_id=c.workspace_id AND r.revision=c.published_revision
          WHERE c.workspace_id=$1`, [workspaceId])).rows[0]
      return { version: row?.draft_version ?? 0, publishedRevision: row?.published_revision ?? 0, publishedAt: row?.published_at?.toISOString() ?? null,
        updatedAt: row?.updated_at?.toISOString() ?? null, observations: row?.observations ?? {}, issueCount: row?.draft ? membershipPublicationIssues(row.draft).length : 0 }
    },
    async observe(workspaceId: string, site: MembershipSite, revision: number) {
      await pool.query(`UPDATE association_membership_catalogues SET observations=jsonb_set(observations,ARRAY[$2],$3::jsonb)
        WHERE workspace_id=$1 AND published_revision=$4`, [workspaceId, site, JSON.stringify({ revision, observedAt: new Date().toISOString() }), revision])
      return { revision, site }
    },
  }
}
