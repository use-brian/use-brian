import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { harnessDefinitionSchema, type HarnessDefinition, type HarnessProjectSnapshot, type HarnessRevision, type HarnessScope, type ProjectProduct } from '../contracts.js'
import { impactRequestSchema, selectHarnessImpact } from '../impact.js'

const workspaceId=randomUUID(), projectId=randomUUID(), target={workspaceId,projectId}
const frontend=randomUUID(), backend=randomUUID(), calendar=randomUUID(), logo=randomUUID(), service=randomUUID()
const project:HarnessScope={kind:'project'}, front:HarnessScope={kind:'product',productId:frontend}, back:HarnessScope={kind:'product',productId:backend}
const cal:HarnessScope={kind:'component',productId:frontend,componentId:calendar}, brand:HarnessScope={kind:'component',productId:frontend,componentId:logo}, api:HarnessScope={kind:'component',productId:backend,componentId:service}
const empty:HarnessDefinition={schemaVersion:1,rules:[],codeChecks:[],acceptanceScenarios:[]}
function node(id:string):ProjectProduct {return {id,workspaceId,projectId,name:id,description:null,status:'active',revision:1,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'}}
function rev(scope:HarnessScope,definition:Partial<HarnessDefinition>={}):HarnessRevision {return {id:randomUUID(),workspaceId,projectId,scope,revision:1,createdBy:randomUUID(),createdAt:'2026-01-01T00:00:00Z',definition:{...empty,...definition}}}
function checks(name:string):Partial<HarnessDefinition> {return {codeChecks:[{key:'unit',kind:'unit',instructions:`Test ${name}`}],acceptanceScenarios:[{key:'journey',title:name,preconditions:['Ready'],steps:['Observe'],criteria:[{key:'works',observation:'Works',evidence:'Screenshot'}]}]}}
function snapshot():HarnessProjectSnapshot {return {
  tree:{products:[node(frontend),node(backend)],components:[{...node(calendar),productId:frontend},{...node(logo),productId:frontend},{...node(service),productId:backend}]},
  revisions:[rev(project,checks('Project')),rev(front,checks('Frontend')),rev(back,checks('Backend')),
    rev(cal,{...checks('Calendar'),sourceMappings:[{repository:'app',pathPrefix:'src/calendar'}]}),
    rev(brand,{...checks('Logo'),sourceMappings:[{repository:'app',pathPrefix:'src/logo'}]}),
    rev(api,{...checks('API'),sourceMappings:[{repository:'api',pathPrefix:'service.ts'}]})],
}}
const titles=(result:ReturnType<typeof selectHarnessImpact>)=>result.acceptanceScenarios.map(x=>x.title).sort()
describe('explicit source/dependency impact planning',()=>{
  it('keeps old definitions unchanged and allows optional bounded metadata only',()=>{
    expect(harnessDefinitionSchema.parse(empty)).toEqual(empty)
    const definition={...empty,sourceMappings:[{repository:' stable-repository ',pathPrefix:'src/calendar.ts'}],dependencies:[{scope:cal,contract:' stable output '}]}
    expect(harnessDefinitionSchema.parse(definition)).toMatchObject({sourceMappings:[{repository:'stable-repository',pathPrefix:'src/calendar.ts'}],dependencies:[{scope:cal,contract:'stable output'}]})
    for(const patch of [{sourceMappings:Array(101).fill({repository:'app',pathPrefix:'src'})},{dependencies:Array(101).fill({scope:project,contract:'contract'})},{dependencies:[{scope:project,contract:'x'.repeat(4001)}]},{sourceMappings:[{repository:'x'.repeat(201),pathPrefix:'src'}]},{sourceMappings:[{repository:'app',pathPrefix:'x'.repeat(501)}]}]) expect(harnessDefinitionSchema.safeParse({...empty,...patch}).success).toBe(false)
  })
  it.each(['../src','src/../lib','/absolute','C:/src','src\\file','src//file','src/./file','src/','./src','src/*','src/?','src/[a]','src/{a,b}','src/%2e%2e',' src','src ','src\nfile','src\u0000file','src\u007ffile'])('rejects nonliteral/noncanonical path %j',path=>{
    expect(impactRequestSchema.safeParse({changedSources:[{repository:'app',path}]}).success).toBe(false)
    expect(harnessDefinitionSchema.safeParse({...empty,sourceMappings:[{repository:'app',pathPrefix:path}]}).success).toBe(false)
  })
  it('matches repository plus slash-segment boundaries; calendar never silently selects logo siblings',()=>{
    const s=snapshot()
    const result=selectHarnessImpact(target,s,{changedSources:[{repository:'app',path:'src/calendar/picker.ts'}]})
    expect(result.status).toBe('ready'); expect(titles(result)).toEqual(['Calendar','Frontend','Project'])
    expect(result.selectedScopes.find(x=>x.scope.kind==='project')?.reasonPaths[0].steps.map(x=>x.kind)).toEqual(['source_mapping','ancestor','ancestor'])
    for(const source of [{repository:'other',path:'src/calendar/picker.ts'},{repository:'app',path:'src/calendarish/picker.ts'}]) {
      const missed=selectHarnessImpact(target,s,{changedSources:[source]}); expect(missed.status).toBe('blocked'); expect(missed.uncovered).toEqual([{kind:'source',source,reason:'no_source_mapping'}]); expect(missed.selectedScopes).toEqual([])
    }
  })
  it('selects all explicit overlapping owners, not a guessed longest-prefix owner',()=>{
    const s=snapshot(); s.revisions[1].definition.sourceMappings=[{repository:'app',pathPrefix:'src'}]
    const result=selectHarnessImpact(target,s,{changedSources:[{repository:'app',path:'src/calendar'}]})
    expect(titles(result)).toEqual(['Calendar','Frontend','Project']); expect(result.selectedScopes.find(x=>x.scope.kind==='project')?.reasonPaths).toHaveLength(2)
    expect(new Set(result.codeChecks.map(x=>x.qualifiedKey)).size).toBe(result.codeChecks.length)
  })
  it('escalates across Products through transitive reverse contracts with explicit reason paths',()=>{
    const s=snapshot(); s.revisions[5].definition.dependencies=[{scope:cal,contract:'API consumes selected date'}]; s.revisions[4].definition.dependencies=[{scope:api,contract:'Logo uses API availability'}]
    const result=selectHarnessImpact(target,s,{scopes:[cal]})
    expect(result.status).toBe('ready'); expect(titles(result)).toEqual(['API','Backend','Calendar','Frontend','Logo','Project'])
    const reason=result.selectedScopes.find(x=>x.scope.kind==='component'&&x.scope.componentId===logo)!.reasonPaths[0]
    expect(reason.steps.map(x=>x.kind)).toEqual(['changed_scope','reverse_dependency','reverse_dependency'])
    expect(reason.steps.slice(1).map(x=>x.contract)).toEqual(['API consumes selected date','Logo uses API availability'])
  })
  it('allows dependencies on ancestor contracts to escalate, without selecting implicit descendants',()=>{
    const s=snapshot(); s.revisions[5].definition.dependencies=[{scope:front,contract:'Uses Frontend contract'}]
    expect(titles(selectHarnessImpact(target,s,{scopes:[cal]}))).toEqual(['API','Backend','Calendar','Frontend','Project'])
    expect(titles(selectHarnessImpact(target,s,{scopes:[back]}))).toEqual(['Backend','Project'])
  })
  it('deduplicates qualified tests rather than collapsing same-key checks in different scopes',()=>{
    const s=snapshot(); const result=selectHarnessImpact(target,s,{scopes:[cal,cal,front]})
    expect(result.codeChecks).toHaveLength(3); expect(result.codeChecks.every(x=>x.key==='unit')).toBe(true)
    expect(new Set(result.codeChecks.map(x=>x.qualifiedKey)).size).toBe(3)
    expect(result.acceptanceScenarios).toHaveLength(3)
  })
  it('bounds cycles with deterministic shortest paths regardless of snapshot/input ordering',()=>{
    const s=snapshot(); s.revisions[3].definition.dependencies=[{scope:api,contract:'date input'}]; s.revisions[5].definition.dependencies=[{scope:cal,contract:'date output'},{scope:api,contract:'self'}]
    const result=selectHarnessImpact(target,s,{scopes:[cal,api]})
    expect(result.status).toBe('ready'); expect(result.selectedScopes).toHaveLength(5)
    const reordered=structuredClone(s); reordered.revisions.reverse(); reordered.tree.products.reverse(); reordered.tree.components.reverse(); reordered.revisions.forEach(r=>r.definition.dependencies?.reverse())
    expect(selectHarnessImpact(target,reordered,{scopes:[api,cal]})).toEqual(result)
    expect(result.selectedScopes.every(x=>x.reasonPaths.every(path=>path.steps.length<=5))).toBe(true)
  })
  it('blocks missing/archived dependency targets, even outside the selected branch; references are not authority',()=>{
    const s=snapshot(); const foreign:HarnessScope={kind:'product',productId:randomUUID()}
    s.revisions[4].definition.dependencies=[{scope:foreign,contract:'Unresolved contract'}]
    const result=selectHarnessImpact(target,s,{scopes:[cal]})
    expect(result.status).toBe('blocked'); expect(result.unresolvedDependencies).toMatchObject([{target:foreign,reason:'missing_or_archived_scope'}])
    expect(titles(result)).not.toContain('Logo'); expect(result.selectedScopes.some(x=>JSON.stringify(x.scope)===JSON.stringify(foreign))).toBe(false)
    s.revisions[4].definition.dependencies=[{scope:cal,contract:'Now archived'}]; s.tree.components[0].status='archived'
    expect(selectHarnessImpact(target,s,{scopes:[brand]}).unresolvedDependencies).toMatchObject([{target:cal}])
    expect(selectHarnessImpact(target,s,{scopes:[cal]}).uncovered).toEqual([{kind:'scope',scope:cal,reason:'missing_or_archived_scope'}])
  })
  it('treats an active target without a definition as a valid dependency scope',()=>{
    const s=snapshot(); s.revisions=s.revisions.filter(r=>r.scope.kind!=='component'||r.scope.componentId!==calendar)
    s.revisions.find(r=>r.scope.kind==='component'&&r.scope.componentId===service)!.definition.dependencies=[{scope:cal,contract:'External implementation contract'}]
    const result=selectHarnessImpact(target,s,{scopes:[cal]}); expect(result.status).toBe('ready'); expect(titles(result)).toEqual(['API','Backend','Frontend','Project'])
  })
  it('blocks selected lineage conflicts but never inherits sibling local rules through a dependency',()=>{
    const s=snapshot(); s.revisions[3].definition.rules=[{key:'color',kind:'local',value:'red',override:false}]; s.revisions[4].definition.rules=[{key:'color',kind:'local',value:'blue',override:false}]
    s.revisions[4].definition.dependencies=[{scope:cal,contract:'Sibling tests without rule inheritance'}]
    expect(selectHarnessImpact(target,s,{scopes:[cal]}).conflicts).toEqual([])
    s.revisions[0].definition.rules=[{key:'color',kind:'invariant',value:'green',override:false}]
    const result=selectHarnessImpact(target,s,{scopes:[cal]}); expect(result.status).toBe('blocked'); expect(result.conflicts).toHaveLength(2); expect(result.conflicts.every(x=>x.conflict.reason==='invariant_override')).toBe(true)
  })
  it('rejects foreign/duplicate snapshot rows and inconsistent component ancestry instead of importing authority',()=>{
    for(const change of [
      (s:HarnessProjectSnapshot)=>{s.revisions[0].projectId=randomUUID()},
      (s:HarnessProjectSnapshot)=>{s.tree.products[0].workspaceId=randomUUID()},
      (s:HarnessProjectSnapshot)=>{s.tree.components[0].productId=randomUUID()},
      (s:HarnessProjectSnapshot)=>{s.revisions.push({...s.revisions[0],id:randomUUID(),revision:2})},
      (s:HarnessProjectSnapshot)=>{s.revisions[0].scope={kind:'product',productId:randomUUID()}},
    ]) {const s=snapshot(); change(s); expect(()=>selectHarnessImpact(target,s,{scopes:[cal]})).toThrow('harness_impact_snapshot_invalid')}
  })
  it('strict request rejects extra context, project pointers, mixed modes and empty changes',()=>{
    for(const value of [{scopes:[]},{changedSources:[]},{scopes:[project],changedSources:[{repository:'app',path:'src'}]},{scopes:[{...front,projectId:randomUUID()}]},{changedSources:[{repository:'app',path:'src',content:'secret'}]},{scopes:[project],revisions:[]}]) expect(impactRequestSchema.safeParse(value).success).toBe(false)
  })
  it('does not mutate inputs and canonicalizes UUID case for dependency/scope matching',()=>{
    const s=snapshot(); const before=structuredClone(s)
    const result=selectHarnessImpact(target,s,{scopes:[{...cal,productId:frontend.toUpperCase(),componentId:calendar.toUpperCase()}]})
    expect(titles(result)).toEqual(['Calendar','Frontend','Project']); expect(s).toEqual(before)
  })
})
