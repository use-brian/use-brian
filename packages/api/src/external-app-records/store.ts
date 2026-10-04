import type pg from 'pg'
import { timingSafeEqual } from 'node:crypto'
import type { AccessContext } from '@use-brian/core'
import { getPool, applyRLSGucs } from '../db/client.js'
import { resolveWorkspaceViewpoint } from '../db/workspace-viewpoint.js'
import { buildAccessPredicate, buildCurrentMemberSourcePredicate } from '../db/access-predicate.js'
import { createCompany, createDeal, readCrmMutationSource, type CrmWriteTransaction } from '../db/crm.js'
import { sourceSignature, RecordsError, PublishInput, ObserveInput, AccessInput, type Context, type Source, type Publication, type Observation, type AppAccess } from './contracts.js'

// Key ordering is not business identity; arrays retain order.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value)
}
export function createExternalAppRecordsStore(options: { sources: readonly Source[]; pool?: pg.Pool }) {
  const pool = options.pool ?? getPool()
  async function transaction<T>(c: Context, externalId: string, observer: boolean, write: (tx: CrmWriteTransaction, access: AccessContext, source: Source, role: string) => Promise<T>): Promise<T> {
    const source = options.sources.find(s => s.workspaceId === c.workspaceId && s.sourceId === c.sourceId)
    if (!source) throw new RecordsError('source_not_configured', 503)
    if (!(observer ? [...source.publisherUserIds, ...source.observerUserIds] : source.publisherUserIds).includes(c.userId)) throw new RecordsError('source_permission_denied', 403)
    const access = await resolveWorkspaceViewpoint(c.userId, c.workspaceId)
    if (!access) throw new RecordsError('membership_required', 403)
    const client = await pool.connect(), effects: Array<() => void> = []
    try {
      await client.query('BEGIN')
      await applyRLSGucs(client, c.userId)
      // Hold current membership across the entire write, including replay.
      const member = await client.query('SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE', [c.workspaceId,c.userId])
      if (!member.rows[0]) throw new RecordsError('membership_required',403)
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['external-app-record',c.workspaceId,c.sourceId,externalId])])
      const result = await write({ client, afterCommit: effect => effects.push(effect) }, access, source, member.rows[0].role)
      await client.query('COMMIT')
      for (const effect of effects) effect()
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  async function target(tx: CrmWriteTransaction, access: AccessContext, id: string, kind: string) {
    // Retain the original binding: canonical merge undo must remain observable.
    const seen = new Set<string>()
    for (let depth=0; depth<32; depth++) {
      if (seen.has(id)) throw new RecordsError('merge_cycle')
      seen.add(id)
      const ap=buildAccessPredicate(access,{alias:'entities',startIdx:4,operation:'mutation'})
      const member=buildCurrentMemberSourcePredicate(access.userId,{alias:'entities',startIdx:ap.nextIdx})
      const row = (await tx.client.query(`SELECT superseded_by FROM entities WHERE id=$1 AND workspace_id=$2 AND kind=$3 AND retracted_at IS NULL AND NOT scope_held AND ${ap.sql} AND ${member.sql} FOR UPDATE`, [id,access.workspaceId,kind,...ap.params,...member.params])).rows[0]
      if (!row) throw new RecordsError('record_unavailable',403)
      if (row.superseded_by) { id=row.superseded_by; continue }
      const entity = await readCrmMutationSource(access,id,[kind],tx.client)
      if (!entity) throw new RecordsError('record_unavailable',403)
      return entity
    }
    throw new RecordsError('merge_chain_too_long')
  }
  const keys = (c: Context, id: string) => [c.workspaceId,c.sourceId,id]
  async function binding(tx: CrmWriteTransaction,c: Context,id: string) {
    return (await tx.client.query('SELECT * FROM external_app_record_bindings WHERE workspace_id=$1 AND source_id=$2 AND external_id=$3',keys(c,id))).rows[0]
  }
  async function receipt(tx: CrmWriteTransaction,c: Context,id: string,access: AccessContext) {
    const b = await binding(tx,c,id)
    if (!b) throw new RecordsError('publication_not_found',404)
    const entity = await target(tx,access,b.entity_id,b.kind)
    const latest = (await tx.client.query('SELECT version,payload FROM external_app_record_versions WHERE workspace_id=$1 AND source_id=$2 AND external_id=$3 ORDER BY version DESC LIMIT 1',keys(c,id))).rows[0]
    const ap=buildAccessPredicate(access,{alias:'v',startIdx:5,operation:'mutation'})
    const member=buildCurrentMemberSourcePredicate(c.userId,{alias:'v',startIdx:ap.nextIdx})
    const visible=await tx.client.query(`SELECT 1 FROM external_app_record_versions v WHERE workspace_id=$1 AND source_id=$2 AND external_id=$3 AND version=$4 AND ${ap.sql} AND ${member.sql}`,[...keys(c,id),latest.version,...ap.params,...member.params])
    if(!visible.rowCount) throw new RecordsError('record_unavailable',403)
    const observation = (await tx.client.query('SELECT provider_version,facts FROM external_app_record_observations WHERE workspace_id=$1 AND source_id=$2 AND external_id=$3 ORDER BY provider_version DESC LIMIT 1',keys(c,id))).rows[0]
    return { externalId:id, entityId:entity.id, originalEntityId:b.entity_id, kind:b.kind, sourceId:c.sourceId, version:Number(latest.version), facts:latest.payload.facts, observation:observation ? {providerVersion:Number(observation.provider_version),facts:observation.facts} : null, merged:entity.id!==b.entity_id }
  }
  return {
    verifySource(c:Context,operation:string,authorization:string,input:unknown,signature:string|undefined):void {
      if(!['publish','access'].includes(operation))return
      const source=options.sources.find(s=>s.workspaceId===c.workspaceId&&s.sourceId===c.sourceId)
      if(!source)throw new RecordsError('source_not_configured',503)
      if(!source.signingSecret||source.signingSecret.length<32)throw new RecordsError('source_attestation_unconfigured',503)
      const expected=sourceSignature(source.signingSecret,c.workspaceId,c.sourceId,operation,c.correlationId,authorization,input)
      if(!signature||!/^[a-f0-9]{64}$/.test(signature)||!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(expected,'hex')))throw new RecordsError('source_attestation_required',403)
    },
    async publish(c: Context, raw: Publication) {
      const input = PublishInput.parse(raw)
      return transaction(c,input.externalId,false,async(tx,access) => {
        let b = await binding(tx,c,input.externalId)
        if (b) {
          if (b.kind!==input.kind || (input.entityId && input.entityId!==b.entity_id && input.entityId!==(await target(tx,access,b.entity_id,b.kind)).id)) throw new RecordsError('binding_conflict')
          await target(tx,access,b.entity_id,b.kind)
        } else {
          const entity = input.entityId ? await target(tx,access,input.entityId,input.kind)
            : input.kind==='company' ? await createCompany(c.userId,{workspaceId:c.workspaceId,name:input.name,access},tx)
            : await createDeal(c.userId,{workspaceId:c.workspaceId,companyId:input.companyId,access},undefined,tx)
          await tx.client.query('INSERT INTO external_app_record_bindings(workspace_id,source_id,external_id,entity_id,kind) VALUES($1,$2,$3,$4,$5)', [...keys(c,input.externalId),entity.id,input.kind])
          b = {entity_id:entity.id,kind:input.kind}
        }
        const versions = await tx.client.query('SELECT version,payload FROM external_app_record_versions WHERE workspace_id=$1 AND source_id=$2 AND external_id=$3 ORDER BY version DESC',keys(c,input.externalId))
        const replay = versions.rows.find(r => Number(r.version)===input.version)
        if (replay) { if (canonical(replay.payload)!==canonical(input)) throw new RecordsError('version_conflict') }
        else {
          if (versions.rows[0] && Number(versions.rows[0].version)>input.version) throw new RecordsError('stale_version')
          const entity=await target(tx,access,b.entity_id,b.kind)
          await tx.client.query('INSERT INTO external_app_record_versions(workspace_id,source_id,external_id,version,payload,actor_user_id,correlation_id,user_id,assistant_id,sensitivity,compartments,project_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[...keys(c,input.externalId),input.version,input,c.userId,c.correlationId,entity.userId,entity.assistantId,entity.sensitivity,entity.compartments,entity.projectIds])
        }
        return receipt(tx,c,input.externalId,access)
      })
    },
    async reconcile(c: Context, externalId: string) { return transaction(c,externalId,true,(tx,access) => receipt(tx,c,externalId,access)) },
    async observe(c: Context, raw: Observation) {
      const input=ObserveInput.parse(raw)
      return transaction(c,input.externalId,true,async(tx,access) => {
        await receipt(tx,c,input.externalId,access)
        const rows=(await tx.client.query('SELECT provider_version,facts FROM external_app_record_observations WHERE workspace_id=$1 AND source_id=$2 AND external_id=$3 ORDER BY provider_version DESC',keys(c,input.externalId))).rows
        const replay=rows.find(r=>Number(r.provider_version)===input.providerVersion)
        if (replay) { if(canonical(replay.facts)!==canonical(input.facts)) throw new RecordsError('provider_version_conflict') }
        else {
          if(rows[0] && Number(rows[0].provider_version)>input.providerVersion) throw new RecordsError('stale_provider_version')
          await tx.client.query('INSERT INTO external_app_record_observations(workspace_id,source_id,external_id,provider_version,facts,actor_user_id,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[...keys(c,input.externalId),input.providerVersion,input.facts,c.userId,c.correlationId])
        }
        return receipt(tx,c,input.externalId,access)
      })
    },
    async reconcileAccess(c: Context, externalId: string) {
      return transaction(c,externalId,false,async(tx,_access,_source,role) => {
        if(!['owner','admin'].includes(role)) throw new RecordsError('admin_required',403)
        const row=(await tx.client.query('SELECT payload FROM external_app_access_versions WHERE workspace_id=$1 AND source_id=$2 AND external_id=$3 ORDER BY version DESC LIMIT 1',keys(c,externalId))).rows[0]
        if(!row) throw new RecordsError('app_access_not_found',404)
        return {sourceId:c.sourceId,...row.payload}
      })
    },
    async access(c: Context, raw: AppAccess) {
      const input=AccessInput.parse(raw)
      return transaction(c,input.externalId,false,async(tx,_access,source,role) => {
        if(!['owner','admin'].includes(role)) throw new RecordsError('admin_required',403)
        if(input.roles.some(r=>!source.appRoles.includes(r))) throw new RecordsError('app_role_not_configured',422)
        if(input.state==='active' && !input.userId) throw new RecordsError('identity_link_required',422)
        if(input.state!=='active' && input.roles.length) throw new RecordsError('inactive_roles_forbidden',422)
        if(input.userId && !(await tx.client.query('SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[c.workspaceId,input.userId])).rowCount) throw new RecordsError('target_membership_required',403)
        const rows=(await tx.client.query('SELECT version,payload FROM external_app_access_versions WHERE workspace_id=$1 AND source_id=$2 AND external_id=$3 ORDER BY version DESC',keys(c,input.externalId))).rows
        if(rows.some(r=>r.payload.userId && r.payload.userId!==input.userId)) throw new RecordsError('identity_binding_conflict')
        const replay=rows.find(r=>Number(r.version)===input.version)
        if(replay) { if(canonical(replay.payload)!==canonical(input)) throw new RecordsError('version_conflict') }
        else {
          if(rows[0] && Number(rows[0].version)>input.version) throw new RecordsError('stale_version')
          await tx.client.query('INSERT INTO external_app_access_versions(workspace_id,source_id,external_id,version,payload,actor_user_id,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[...keys(c,input.externalId),input.version,input,c.userId,c.correlationId])
        }
        return {sourceId:c.sourceId,...(replay ? rows[0].payload : input)}
      })
    },
  }
}
export type ExternalAppRecordsStore = ReturnType<typeof createExternalAppRecordsStore>
