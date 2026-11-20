/** [COMP:api/native-turn-frame] The reviewed templates are the released migration. */
import {execFileSync,spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {expect,it} from 'vitest'
it('reproduces the authenticated forward migration from its reviewed sources',()=>{
 const output=execFileSync(process.execPath,[fileURLToPath(new URL('../../scripts/conversation-store/build.mjs',import.meta.url)),'--check'],{encoding:'utf8'})
 expect(output).toContain('Conversation migration matches source templates')
})
it('reproduces the durable publication forward migration from its reviewed sources',()=>{
 const output=execFileSync(process.execPath,[fileURLToPath(new URL('../../scripts/conversation-store/build-publication-recovery.mjs',import.meta.url)),'--check'],{encoding:'utf8'})
 expect(output).toContain('Durable publication migration matches sources')
})

type ConstraintTemplate={conname:string;conbin:unknown;connamespace:unknown}
type CatalogTemplate={relations:unknown[][];defaults:Array<{oid:unknown;adbin:unknown;adnum:number}>;constraints:ConstraintTemplate[];constraint?:ConstraintTemplate;columns:unknown[][];[key:string]:unknown}
type ManifestPart=string|{slot:{kind:string;identity:string;template?:CatalogTemplate}}
type PublicationManifest={
 sourceOrdering:{format:number;signature:string;source:{file:string;sha256:string};templateSha256:string;operations:Array<{identity:string;members:number;membersSha256?:string;sourceSha256:string}>}
 source:Record<string,string>
 retainedGuard:{format:number;signature:string;bodySha256:string;roster:string[];source:Array<{file:string;sha256:string}>}
 inheritedFunctionExecute:{defaultHistory:{file:string;sha256:string};functions:Array<{signature:string;publicExecute:boolean;source:Array<{file:string;sha256:string}>}>}
 predecessorFingerprints:Record<string,string>
 argumentDefaults:Record<string,{profile:string;nativeAst:string}>
 catalogExpressions:Record<string,{profile:string;nativeAst:string}>
 historicalProjections:{source:Record<string,string>;profiles:Array<{signature:string;bodySha256:string;projection:{body:string;namespace:unknown;language:unknown;securityDefiner:boolean}}>} 
 contracts:Array<{signature:string;bodyParts:ManifestPart[];metadata:{proargdefaults:unknown;pronargdefaults:number;proargtypes:unknown[]};acl:Array<{grantee:string;grantor:string;privilege:string;grantable:boolean}>}>
}
const publicationBuilder=fileURLToPath(new URL('../../scripts/conversation-store/build-publication-recovery.mjs',import.meta.url))
const publicationManifest=fileURLToPath(new URL('../../scripts/conversation-store/publication-recovery-predecessors.json',import.meta.url))
function validateMutation(mutate:(manifest:PublicationManifest)=>void):string{
 const directory=mkdtempSync(join(tmpdir(),'publication-manifest-'))
 try{
  const manifest=JSON.parse(readFileSync(publicationManifest,'utf8')) as PublicationManifest
  mutate(manifest)
  const path=join(directory,'reviewed.json')
  writeFileSync(path,JSON.stringify(manifest))
  const result=spawnSync(process.execPath,[publicationBuilder,'--validate-manifest',path],{encoding:'utf8'})
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status).toBe(1)
  return result.stderr
 }finally{rmSync(directory,{recursive:true,force:true})}
}

it.each([
 ['capture_conversation_evidence(', 'native_turn_helpers_current()'],
 ['native_turn_capture_event()', 'native_turn_capture_event(jsonb)'],
 ['read_native_personal_title_group_evidence(', 'application_native_title_acquisition_helpers_current()'],
 ['read_native_session_field_dependencies(', 'native_turn_helpers_current()'],
])('rejects a dependency pin left literal in %s', (signature,dependency)=>{
 const error=validateMutation(manifest=>{
  const contract=manifest.contracts.find(item=>item.signature.startsWith(signature))!
  expect(contract).toBeDefined()
  let index=-1
  for(const [candidate,part] of contract.bodyParts.entries()){
   if(typeof part!=='string'&&part.slot.kind==='fingerprint'&&part.slot.identity===dependency)index=candidate
  }
  expect(index).toBeGreaterThan(0)
  const before=contract.bodyParts[index-1],after=contract.bodyParts[index+1]
  expect(typeof before).toBe('string')
  expect(typeof after).toBe('string')
  // Reproduce the failed extractor's output, including the complete old literal.
  contract.bodyParts.splice(index-1,3,`${before}${manifest.predecessorFingerprints[dependency]}${after}`)
 })
 expect(error).toContain('publication_unrepresented_fingerprint')
})

it('rejects an unreviewed hash literal instead of treating it as a dependency',()=>{
 const error=validateMutation(manifest=>{
  const contract=manifest.contracts.find(item=>item.signature==='sensitivity_rank(text)')!
  expect(contract).toBeDefined()
  contract.bodyParts.push(`\nPERFORM '${'f'.repeat(64)}';`)
 })
 expect(error).toContain('publication_hash_literal_review_changed')
})

it('rejects a named pin moved to a different reviewed dependency',()=>{
 const error=validateMutation(manifest=>{
  const contract=manifest.contracts.find(item=>item.signature.startsWith('capture_conversation_evidence('))!
  const part=contract.bodyParts.find(part=>typeof part!=='string'&&part.slot.kind==='fingerprint')
  expect(part).toBeDefined()
  if(typeof part!=='string'&&part)part.slot.identity='sensitivity_rank(text)'
 })
 expect(error).toContain('publication_hash_literal_review_changed')
})

const defaultSignature='application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)'
it.each(['missing','extra'] as const)('rejects %s default profile bindings',change=>{
 const error=validateMutation(manifest=>{
  if(change==='missing')delete manifest.argumentDefaults[defaultSignature]
  else manifest.argumentDefaults['fictional_unreviewed_default(boolean)']=manifest.argumentDefaults[defaultSignature]
 })
 expect(error).toContain('publication_default_profile_roster_changed')
})
it.each(['integer_zero','fictional_default_profile'])('rejects a default slot assigned %s',identity=>{
 const error=validateMutation(manifest=>{
  const contract=manifest.contracts.find(item=>item.signature===defaultSignature)!
  contract.metadata.proargdefaults={$slot:{kind:'argumentDefaults',identity,encoding:'string'}}
 })
 expect(error).toContain('publication_default_profile_changed')
})
it.each(['count','type'] as const)('binds reviewed defaults to their trailing argument %s',change=>{
 const error=validateMutation(manifest=>{
  const metadata=manifest.contracts.find(item=>item.signature===defaultSignature)!.metadata
  if(change==='count')metadata.pronargdefaults++
  else metadata.proargtypes[metadata.proargtypes.length-1]='23'
 })
 expect(error).toContain('publication_default_argument_binding_changed')
})
it('preserves the exact native default provenance while compiling a local AST',()=>{
 const error=validateMutation(manifest=>{
  manifest.argumentDefaults[defaultSignature].nativeAst=manifest.argumentDefaults[defaultSignature].nativeAst.replace('[ 0 0 0 0 0 0 0 0 ]','[ 1 0 0 0 0 0 0 0 ]')
 })
 expect(error).toContain('publication_default_profile_changed')
})

function catalogTemplate(manifest:PublicationManifest,signature:string,index:number):CatalogTemplate{
 const part=manifest.contracts.find(contract=>contract.signature===signature)!.bodyParts[index]
 if(typeof part==='string'||!part.slot.template)throw new Error('Fixture catalog template missing')
 return part.slot.template
}
it.each(['missing','extra'] as const)('rejects a %s historical source projection',change=>{
 const error=validateMutation(manifest=>{
  if(change==='missing')manifest.historicalProjections.profiles.pop()
  else manifest.historicalProjections.profiles.push(manifest.historicalProjections.profiles[0])
 })
 expect(error).toContain('publication_historical_profile_roster_changed')
})
it('refuses the current ancestor body as a replacement for the historical stale projection',()=>{
 const error=validateMutation(manifest=>{
  const historical=manifest.historicalProjections.profiles.find(profile=>profile.signature==='scope_source_ancestors(uuid,text,uuid)')!
  const current=manifest.contracts.find(contract=>contract.signature===historical.signature)!.bodyParts[0]
  expect(typeof current).toBe('string')
  if(typeof current!=='string')throw new Error('Fixture current body missing')
  expect(current).not.toBe(historical.projection.body)
  historical.projection.body=current
  historical.bodySha256=createHash('sha256').update(current).digest('hex')
 })
 expect(error).toContain('publication_historical_profile_changed')
})
it.each(['namespace','language','securityDefiner'] as const)('binds historical projection %s to reviewed source',field=>{
 const error=validateMutation(manifest=>{
  const projection=manifest.historicalProjections.profiles[0].projection
  if(field==='securityDefiner')projection.securityDefiner=false
  else projection[field]={$slot:{kind:field,identity:'fictional_source_identity',encoding:'string'}}
 })
 expect(error).toContain('publication_historical_profile_changed')
})
it('refuses a historical source checksum changed independently of its immutable migration',()=>{
 const error=validateMutation(manifest=>{
  manifest.historicalProjections.source[Object.keys(manifest.historicalProjections.source)[0]]='0'.repeat(64)
 })
 expect(error).toContain('publication_historical_source_changed')
})
it('binds a historical hash slot to its exact named function tuple',()=>{
 const error=validateMutation(manifest=>{
  const contract=manifest.contracts.find(c=>c.signature==='application_scope_lineage(uuid,text[],uuid[],text[])')!
  const part=contract.bodyParts.find(p=>typeof p!=='string'&&p.slot.kind==='historicalProjection')
  if(!part||typeof part==='string')throw new Error('Fixture projection slot missing')
  part.slot.identity='scope_source_ancestors(uuid,text,uuid)'
 })
 expect(error).toContain('publication_historical_slot_changed')
})
it.each(['owner','acl','rls'] as const)('rejects an unreviewed relation tuple %s field',field=>{
 const error=validateMutation(manifest=>{
  const tuple=catalogTemplate(manifest,'native_turn_helpers_current()',3).relations[0]
  if(field==='owner')tuple[1]='16384'
  else if(field==='acl')tuple[2]=['PUBLIC=r/fictional_owner']
  else tuple[4]=false
 })
 expect(error).toContain('publication_relation_tuple_changed')
})
it('binds the default OID to the reviewed named column',()=>{
 const error=validateMutation(manifest=>{
  catalogTemplate(manifest,'native_turn_publication_contract()',1).defaults[0].oid={$slot:{kind:'columnDefaultOid',identity:'public.native_turn_publication_events.fired',encoding:'string'}}
 })
 expect(error).toContain('publication_column_default_binding_changed')
})
it.each(['position','type'] as const)('binds source-compiled expressions to the attribute %s',field=>{
 const error=validateMutation(manifest=>{
  const column=catalogTemplate(manifest,'native_turn_publication_contract()',1).columns.find(column=>column[2]==='format')!
  column[field==='position'?1:3]=field==='position'?9:'25'
 })
 expect(error).toContain('publication_expression_attribute_changed')
})
it('rejects changed source expression provenance',()=>{
 const error=validateMutation(manifest=>{
  manifest.catalogExpressions['public.native_turn_frames.native_turn_frames_format_check'].nativeAst+=' '
 })
 expect(error).toContain('publication_catalog_expression_changed')
})
it('refuses a compiled expression slot outside the reviewed catalog fields',()=>{
 const error=validateMutation(manifest=>{
  catalogTemplate(manifest,'native_turn_publication_contract()',1).fictional_field={$slot:{kind:'catalogExpression',identity:'table_check_false',encoding:'string'}}
 })
 expect(error).toContain('publication_catalog_slot_locations_changed')
})

it.each(['missing','extra','late-default','public-access','source'] as const)('binds the finite inherited function ACL profile: %s',change=>{
 const error=validateMutation(manifest=>{
  const profile=manifest.inheritedFunctionExecute
  if(change==='missing')profile.functions.pop()
  else if(change==='extra')profile.functions.push({...profile.functions[0],signature:'fictional_unreviewed_helper()'})
  else if(change==='late-default')Reflect.set(profile.functions[0],'requiresCurrentDefault',true)
  else if(change==='public-access')profile.functions.find(row=>row.publicExecute)!.publicExecute=false
  else profile.functions[0].source[0].sha256='0'.repeat(64)
 })
 expect(error).toContain('publication_inherited_acl_profile_changed')
})
it.each(['grantee','grantor','grant-option','public-access'] as const)('keeps the canonical inherited-helper ACL closed: %s',change=>{
 const error=validateMutation(manifest=>{
  const contract=manifest.contracts.find(row=>row.signature==='crm_install_erasure_capture()')!
  if(change==='grantee')contract.acl.push({...contract.acl[0],grantee:'app_user'})
  else if(change==='grantor')contract.acl[0].grantor='app_user'
  else if(change==='grant-option')contract.acl[0].grantable=true
  else contract.acl.push({...contract.acl[0],grantee:'PUBLIC'})
 })
 expect(error).toContain('publication_inherited_acl_canonical_changed')
})
it.each(['literal','wrong-constraint','wrong-kind'] as const)('binds each publication constraint namespace to its source identity: %s',change=>{
 const error=validateMutation(manifest=>{
  const constraint=catalogTemplate(manifest,'native_turn_publication_contract()',1).constraints[0]
  constraint.connamespace=change==='literal'?'2200':{$slot:{kind:change==='wrong-kind'?'namespace':'constraintNamespace',
   identity:change==='wrong-kind'?'public':'public.native_turn_frames.fictional_other_constraint',encoding:'string'}}
 })
 expect(error).toContain('publication_constraint_namespace_binding_changed')
})
it('binds the surviving derivation FK namespace to its exact named constraint',()=>{
 const error=validateMutation(manifest=>{
  catalogTemplate(manifest,'native_turn_helpers_current()',3).constraint!.connamespace={$slot:{kind:'constraintNamespace',
   identity:'public.scope_derivation_sources.fictional_other_constraint',encoding:'string'}}
 })
 expect(error).toContain('publication_constraint_namespace_binding_changed')
})
it.each(['missing','extra'] as const)('preserves all38 named constraint namespace slots: %s',change=>{
 const error=validateMutation(manifest=>{
  const constraints=catalogTemplate(manifest,'native_turn_publication_contract()',1).constraints
  const index=constraints.findIndex(constraint=>constraint.conname==='native_turn_frames_id_not_null')
  expect(index).toBeGreaterThanOrEqual(0)
  if(change==='missing')constraints.splice(index,1)
  else constraints.push(structuredClone(constraints[index]))
 })
 expect(error).toContain('publication_constraint_namespace_roster_changed')
})
it.each(['function-origin','default-history'] as const)('requires the separately named inherited ACL provenance even after coherent deletion: %s',kind=>{
 const error=validateMutation(manifest=>{
  const ref=kind==='function-origin'?manifest.inheritedFunctionExecute.functions[0].source[0]:manifest.inheritedFunctionExecute.defaultHistory
  delete manifest.source[ref.file]
  Reflect.deleteProperty(ref,'sha256')
 })
 expect(error).toContain('publication_inherited_acl_source_changed')
})
it.each(['body','roster','metadata-owner','source'] as const)('authenticates the retained guard from its independent source profile: %s',change=>{
 const error=validateMutation(manifest=>{
  if(change==='body')manifest.retainedGuard.bodySha256='0'.repeat(64)
  else if(change==='roster')manifest.retainedGuard.roster.push('fictional_unreviewed_helper()')
  else if(change==='metadata-owner')Reflect.set(manifest.retainedGuard,'owner','fictional_owner')
  else manifest.retainedGuard.source[0].sha256='0'.repeat(64)
 })
 expect(error).toContain('publication_retained_guard_profile_changed')
})
it('requires retained guard source provenance even after a coherent deletion',()=>{
 const error=validateMutation(manifest=>{
  const ref=manifest.retainedGuard.source[0]
  delete manifest.source[ref.file];Reflect.deleteProperty(ref,'sha256')
 })
 expect(error).toContain('publication_retained_guard_source_changed')
})

it.each(['missing','extra-owner','source','template','predicate-count','roster-count','roster-missing','roster-duplicate','roster-extra','coherent-body'] as const)('binds source-owned historical collation ordering: %s',change=>{
 const error=validateMutation(manifest=>{
  if(change==='missing')delete (manifest as Partial<PublicationManifest>).sourceOrdering
  else if(change==='extra-owner')manifest.sourceOrdering.signature='native_turn_publication_contract()'
  else if(change==='source')manifest.sourceOrdering.source.sha256='0'.repeat(64)
  else if(change==='template')manifest.sourceOrdering.templateSha256='0'.repeat(64)
  else if(change==='predicate-count')manifest.sourceOrdering.operations[0].members++
  else if(change==='roster-count')manifest.sourceOrdering.operations[1].members++
  else if(change.startsWith('roster-')){
   const parts=manifest.contracts.find(c=>c.signature==='native_turn_helpers_current()')!.bodyParts
   const tail=parts[4] as string,anchor='array_agg(h.signature ORDER BY h.signature)=',start=tail.indexOf(anchor)+anchor.length,end=tail.indexOf('::text[]',start)
   const roster=tail.slice(start,end),first=roster.match(/'((?:[^']|'')*)'/)![0]
   const next=change==='roster-missing'?roster.replace(first+',',''):roster.replace('ARRAY[','ARRAY['+(change==='roster-extra'?"'unreviewed_extra()',":first+','))
   parts[4]=tail.slice(0,start)+next+tail.slice(end)
   manifest.sourceOrdering.templateSha256=createHash('sha256').update(JSON.stringify(parts)).digest('hex')
  }
  else{
   const parts=manifest.contracts.find(c=>c.signature==='native_turn_helpers_current()')!.bodyParts
   parts[0]=(parts[0] as string).replace('SELECT native_turn_publication_contract()','SELECT true OR native_turn_publication_contract()')
   manifest.sourceOrdering.templateSha256=createHash('sha256').update(JSON.stringify(parts)).digest('hex')
  }
 })
 expect(error).toMatch(/publication_source_ordering_(?:profile|provenance)_changed/)
})
