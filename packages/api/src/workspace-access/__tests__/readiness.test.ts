import { describe, expect, it } from 'vitest'
import { departmentalReadiness, getDepartmentalReadinessSystem } from '../readiness.js'
import type { ContextReadiness, ContextReadinessCheckId, ReadinessQuery } from '../../context-scope/context-readiness.js'

function completeEvidence(): ContextReadiness {
  const ids: ContextReadinessCheckId[] = [
    'row_store_coverage', 'turn_entry_points', 'write_inheritance', 'session_isolation',
    'teamspace_agent_access', 'connectors', 'ingest', 'background_lanes',
    'derived_writes', 'delegation', 'operation_separation', 'replay_delivery',
    'grant_expiry', 'org_references', 'scope_review',
  ]
  return { enforcementVersion: 2, readyForActivation: true, legacyGeneral: {},
    checks: ids.map(id => ({ id, ready: true, blocking: true, detail: 'Fixture evidence' })) }
}

describe('[COMP:api/departmental-readiness] release boundary', () => {
  it('cannot turn a version number or aggregate boolean into missing enforcement proof', () => {
    expect(departmentalReadiness({ ...completeEvidence(), checks: [] })).toMatchObject({
      ready: false, missingCapabilities: expect.arrayContaining(['derived_writes', 'operation_separation', 'replay_delivery', 'scope_review']),
    })
  })
  it('requires the deployed release version as well as every capability', () => {
    expect(departmentalReadiness({ ...completeEvidence(), enforcementVersion: 1 })).toMatchObject({ready:false,missingCapabilities:['enforcement_version']})
    expect(departmentalReadiness(completeEvidence()).ready).toBe(true)
  })
  it.each(['missing', 'failed', 'nonblocking', 'duplicate'] as const)('refuses %s operation-separation evidence', mode => {
    const evidence=completeEvidence(), item=evidence.checks.find(check=>check.id==='operation_separation')!
    if(mode==='missing')evidence.checks=evidence.checks.filter(check=>check!==item)
    if(mode==='failed')item.ready=false
    if(mode==='nonblocking')item.blocking=false
    if(mode==='duplicate')evidence.checks.push({...item})
    expect(departmentalReadiness(evidence)).toMatchObject({ready:false,missingCapabilities:expect.arrayContaining(['operation_separation'])})
  })
  it('retains additional blocking failures and the underlying activation verdict', () => {
    const evidence=completeEvidence()
    evidence.checks.push({id:'legacy_data',ready:false,blocking:true,detail:'Inventory changed'})
    evidence.readyForActivation=false
    expect(departmentalReadiness(evidence)).toMatchObject({ready:false,missingCapabilities:expect.arrayContaining(['legacy_data','context_activation'])})
  })
  it('reports the real current release as unavailable without accepting caller readiness', async () => {
    let queries=0
    const emptySchema:ReadinessQuery=async()=>{queries++;return{rows:[]}}
    const result=await getDepartmentalReadinessSystem('workspace-fixture',emptySchema)
    expect(result.ready).toBe(false)
    expect(result.missingCapabilities).toEqual(expect.arrayContaining(['enforcement_version','derived_writes','grant_expiry','org_references','scope_review']))
    expect(queries).toBe(0)
  })
})
