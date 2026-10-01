// @vitest-environment jsdom
import {act} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {MigrationProgressPanel,migrationMessage} from '../migration-progress';
import {I18nProvider} from '@/lib/i18n/client';
import {en} from '@/lib/i18n/dictionaries/en';
import {ja} from '@/lib/i18n/dictionaries/ja';
import {zh} from '@/lib/i18n/dictionaries/zh';
import {zhCN} from '@/lib/i18n/dictionaries/zh-cn';
import {CommandReviewEffects} from '../command-review-effects';
import {invalidateSurfaceCache,SurfaceCacheEvictionError} from '@/lib/surface-cache';
import {protectProjection} from '@/lib/use-protected-projection';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const mocks=vi.hoisted(()=>({registry:vi.fn(),mode:vi.fn(),list:vi.fn(),detail:vi.fn(),prepare:vi.fn(),apply:vi.fn(),state:vi.fn(),confirm:vi.fn(),viewer:{workspaceId:'w',me:{id:'admin'}}}));
vi.mock('@/lib/workspace-context',()=>({useWorkspaceContext:()=>mocks.viewer}));
vi.mock('@/lib/surface-prefetch',()=>({workspaceDepartmentRegistryCacheKey:(w:string,u:string)=>`workspace-access:${w}:${u}:registry`,workspaceAccessModeCacheKey:(w:string,u:string)=>`workspace-access:${w}:${u}:mode`,workspaceAccessMigrationCacheKey:(w:string,u:string,k:string,c:string)=>`workspace-access:${w}:${u}:migration:${k}:${c}`}));
vi.mock('@/lib/api/workspace-access',()=>({isResourceMigrationItem:(item:{proposed_action:{type:string}})=>item.proposed_action.type==='resource.scope',fetchWorkspaceDepartmentRegistry:mocks.registry,fetchWorkspaceAccessMode:mocks.mode,fetchMigrationPlans:mocks.list,fetchMigrationPlan:mocks.detail,prepareMigrationItem:mocks.prepare,applyMigrationItem:mocks.apply,setMigrationPlanState:mocks.state,ORGANIZATION_CHANGED_EVENT:'brian:organization-changed'}));
vi.mock('@/components/ui/confirm-dialog',()=>({confirmDialog:mocks.confirm}));
vi.mock('@/components/chrome/surface-skeleton',()=>({SurfaceSkeletonFor:()=> <div data-skeleton/>}));
const t=en.accessMigration;
let root:Root,host:HTMLDivElement;
const plan=()=>({id:'plan',actor_user_id:'admin',source_mode:'departments',target_mode:'simple',status:'proposed',expires_at:'2099-01-01',summary_counts:{applied:1,total:2},blockers:['full_inventory_required','intake_certification_required','mode_finalizer_unavailable'],items:[{id:'done',subject_id:'person-a',reason:'Done before',status:'applied',proposed_action:{type:'department.member.set',userId:'person-a',teamId:'team',enabled:true}},{id:'pending',subject_id:'person-b',reason:'Explicit pilot',subject_kind:'member',before_state:{kind:'member',resourceAuthorizationRequired:true,person:{id:'person-b',name:'Casey',role:'member',access:{readTeamIds:[],membershipTeamIds:[],hasUnlistedReadScope:false,hasUnlistedMembershipScope:false}}},after_state:{kind:'member',resourceAuthorizationRequired:true,person:{id:'person-b',name:'Casey',role:'member',access:{readTeamIds:['team'],membershipTeamIds:['team'],hasUnlistedReadScope:false,hasUnlistedMembershipScope:false}}},status:'pending',proposed_action:{type:'department.member.set',userId:'person-b',teamId:'team',enabled:true}}]});
function resourceFixture(action:'assign_team'|'consolidate_default'='assign_team'){
 const source={workspaceId:'w',resourceKind:'memory',resourceId:'resource-1',version:'1',userId:'person-b',assistantId:null,sensitivity:'confidential',compartments:['old-department'],projectIds:['project-1'],held:false,validTo:null,retractedAt:null};
 const content={title:'Frozen migration document',text:'Saved source excerpt'};
 const impact={version:2,descendants:[{resourceKind:'memory',resourceId:'derived-1',version:'4',held:false}],dependents:{},...(action==='consolidate_default'?{consolidation:{version:1,sourceFloor:{version:1,nodes:[source],edges:[]},before:source,after:{...source,compartments:['new-department']},visibility:{visibility:'private',userId:'person-b'},audiences:[{userId:'person-b',assistantId:'assistant-a',readBefore:false,readAfter:true,editBefore:true,editAfter:false}],futureDefaultMembersWarning:'server diagnostic'}}:{})};
 const item={id:'resource-item',subject_kind:'memory',subject_id:'resource-1',reason:'Explicit resource pilot',status:'pending',proposed_action:{type:'resource.scope',resourceKind:'memory',resourceId:'resource-1',action,targetTeamId:'team'},before_state:{source,content},after_state:{action,targetTeamId:'team',impact,allowedActions:[action]},scope_review_id:'resource-review',command_review_id:null,diagnostic_code:null};
 const review={id:'resource-review',workspaceId:'w',resourceKind:'memory',action,targetTeamId:'team',targetCompartment:'new-department',reason:item.reason,payloadHash:'resource-hash',selectionRevision:'1',policyRevision:'12',version:'9',expiresAt:null,status:'preview',completeCoverage:false,validForMs:30000,items:[{resourceId:'resource-1',resourceVersion:'1',source,content,impact,status:'pending',resultVersion:null,errorCode:null}]};
 const confirmation={kind:'resource',reviewId:review.id,expectedVersion:'9',payloadHash:review.payloadHash,expiresAt:new Date(Date.now()+600000).toISOString()};
 return {kind:'resource',review,item,confirmation};
}
async function openResource(action:'assign_team'|'consolidate_default'='assign_team'){
 const result=resourceFixture(action);mocks.detail.mockImplementation(async()=>protectedData({...plan(),items:[result.item]}));mocks.prepare.mockResolvedValue(result);mocks.apply.mockResolvedValue({...result.item,kind:'resource',status:'applied',review:{...result.review,status:'complete'}});
 await render();await click(t.inspect);return result;
}
const protectedData=<T extends object>(value:T)=>protectProjection({...value,validForMs:30000},performance.now());
async function render(){await act(async()=>root.render(<I18nProvider locale="en" dict={en}><MigrationProgressPanel/></I18nProvider>));}
async function click(label:string){const button=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label);expect(button).toBeDefined();await act(async()=>button!.click());}
beforeEach(()=>{
 vi.clearAllMocks();mocks.viewer.me.id='admin';invalidateSurfaceCache('workspace-access:');
 mocks.registry.mockImplementation(async()=>protectedData({canAdminister:true,people:[{id:'person-a',name:'Riley'},{id:'person-b',name:'Casey'}],assistants:[{id:'assistant-a',name:'Brian Research'}],teams:[{id:'team',name:'Research'}]}));
 mocks.mode.mockImplementation(async()=>protectedData({mode:'departments',setupState:'legacy',defaultDepartmentName:null}));
 mocks.list.mockImplementation(async()=>protectedData({plans:[plan()]}));mocks.detail.mockImplementation(async()=>protectedData(plan()));
 mocks.prepare.mockResolvedValue({item:plan().items[1],review:{id:'saved',payloadHash:'exact-hash',policyRevision:'12',validForMs:30000,expiresAt:'2099-01-01',changes:[],command:plan().items[1].proposed_action}});
 mocks.apply.mockResolvedValue({...plan().items[1],status:'applied'});mocks.confirm.mockResolvedValue(true);mocks.state.mockResolvedValue(plan());
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();invalidateSurfaceCache('workspace-access:');});
describe('[COMP:app-web/workspace-access] principal migration progress',()=>{
 it('reports actual mode and setup, applied counts, blockers and irreversible warning without activation controls',async()=>{
   await render();expect(host.textContent).toContain(t.departments);expect(host.textContent).toContain(t.legacy);expect(host.textContent).toContain(t.missing);
   await click(t.inspect);expect(host.textContent).toContain(`${t.appliedCount}: 1 / 2`);expect(host.textContent).toContain(t.warning);
   for(const code of plan().blockers)expect(host.textContent).toContain(migrationMessage(code,t));
   expect(host.querySelector('select,input,textarea')).toBeNull();expect(host.textContent).toContain(t.limitation);
 });
 it('confirms the exact saved item/hash with effects and never applies already-applied rows',async()=>{
   await render();await click(t.inspect);expect([...host.querySelectorAll('button')].filter(b=>b.textContent===t.review)).toHaveLength(1);
   await click(t.review);expect(mocks.prepare).toHaveBeenCalledWith('w','plan','pending');
   expect(mocks.confirm.mock.calls[0][0].description).toContain(t.warning);
   const preview=renderToStaticMarkup(<I18nProvider locale="en" dict={en}>{mocks.confirm.mock.calls[0][0].content}</I18nProvider>);
   for(const text of ['Casey','Research','person-b','team',t.resourceDisclaimer,en.workspaceAccess.reviewBefore,en.workspaceAccess.reviewAfter])expect(preview).toContain(text);
   expect(mocks.apply).toHaveBeenCalledWith('w','plan','pending',{type:'access.command.apply',reviewId:'saved',payloadHash:'exact-hash'});
 });
 it('names assistant and target without claiming configured assignments equal effective reach',async()=>{
   const item={id:'assistant-item',subject_id:'assistant-a',subject_kind:'assistant',reason:'Explicit assistant pilot',status:'pending',proposed_action:{type:'department.assistant.set',assistantId:'assistant-a',teamId:'team',enabled:true},before_state:{kind:'assistant',readCompartments:['opaque-scope'],mutationCompartments:['opaque-scope'],resourceAuthorizationRequired:true,humanIntersectionRequired:true,config:{teamIds:[]}},after_state:{kind:'assistant',readCompartments:['opaque-scope'],mutationCompartments:['opaque-scope'],resourceAuthorizationRequired:true,humanIntersectionRequired:true,config:{teamIds:['team']}}};
   mocks.detail.mockImplementation(async()=>protectedData({...plan(),items:[item]}));await render();await click(t.inspect);
   for(const text of ['Brian Research','Research',t.humanDisclaimer,t.unavailableScope,t.configuredTeams])expect(host.textContent).toContain(text);
   expect(host.textContent).not.toContain('opaque-scope');
 });
 it('does not apply a declined or expired preview',async()=>{
   mocks.confirm.mockResolvedValue(false);await render();await click(t.inspect);await click(t.review);expect(mocks.apply).not.toHaveBeenCalled();
   mocks.prepare.mockResolvedValue({review:{id:'expired',payloadHash:'h',validForMs:0}});await click(t.review);expect(mocks.apply).not.toHaveBeenCalled();expect(host.textContent).toContain(en.workspaceAccess.reviewExpired);
 });
 it('refreshes an expired item into a newly confirmed hash without replacing the plan',async()=>{
   mocks.prepare.mockResolvedValueOnce({review:{id:'old',payloadHash:'expired-hash',validForMs:0}});
   await render();await click(t.inspect);await click(t.review);expect(mocks.confirm).not.toHaveBeenCalled();
   await click(t.review);expect(mocks.prepare).toHaveBeenCalledTimes(2);expect(mocks.confirm).toHaveBeenCalledTimes(1);
   expect(mocks.apply).toHaveBeenCalledWith('w','plan','pending',{type:'access.command.apply',reviewId:'saved',payloadHash:'exact-hash'});
 });
 it('purges named projections on registry authority denial',async()=>{
   await render();await click(t.inspect);expect(host.textContent).toContain('Casey');
   mocks.registry.mockRejectedValue(new SurfaceCacheEvictionError(new Error('not_found')));
   await act(async()=>invalidateSurfaceCache('workspace-access:w:admin:registry'));
   expect(host.textContent).not.toContain('Casey');expect(host.textContent).not.toContain('Explicit pilot');expect(host.textContent).toContain(en.workspaceAccess.loadError);
 });
 it('labels the canonical default department field in saved review effects',()=>{
   const html=renderToStaticMarkup(<I18nProvider locale="en" dict={en}><CommandReviewEffects review={{id:'r',payloadHash:'h',policyRevision:'1',expiresAt:'2099-01-01',validForMs:30000,command:{type:'workspace.default_department.set',teamId:'team'},changes:[{field:'default_department_id',before:[],after:[{kind:'text',value:'Research'}]}]}}/></I18nProvider>);
   expect(html).toContain(en.workspaceAccess.reviewDefaultDepartment);expect(html).toContain('Research');
 });
 it('retries a lost apply receipt with the same hash without preparing another proposal',async()=>{
   mocks.apply.mockRejectedValueOnce(new Error('network'));await render();await click(t.inspect);await click(t.review);await click(en.workspaceAccess.retryChange);
   expect(mocks.prepare).toHaveBeenCalledTimes(1);expect(mocks.confirm).toHaveBeenCalledTimes(1);expect(mocks.apply.mock.calls[0]).toEqual(mocks.apply.mock.calls[1]);
 });
 it('warns before cancel and immediately stops a plan with saved reviews',async()=>{
   await render();await click(t.inspect);await click(t.review);await click(t.cancel);
   expect(mocks.confirm.mock.calls.at(-1)![0].description).toBe(t.warning);expect(mocks.state).toHaveBeenCalledWith('w','plan','cancelled');
 });
 it('resumes a paused plan using the backend proposed state',async()=>{
   mocks.detail.mockImplementation(async()=>protectedData({...plan(),status:'paused'}));await render();await click(t.inspect);await click(t.resume);expect(mocks.state).toHaveBeenCalledWith('w','plan','proposed');
 });
 it('disables expired plans and another administrator cannot apply',async()=>{
   mocks.detail.mockImplementation(async()=>protectedData({...plan(),actor_user_id:'other',expires_at:'2000-01-01'}));await render();await click(t.inspect);
   expect(host.textContent).toContain(t.expired);expect(host.textContent).toContain(t.actor);await click(t.review);expect(mocks.prepare).not.toHaveBeenCalled();
 });
 it('drops old viewer projections when identity changes',async()=>{
   await render();await click(t.inspect);expect(host.textContent).toContain('Explicit pilot');mocks.viewer.me.id='other';mocks.list.mockImplementation(()=>new Promise(()=>{}));await render();expect(host.textContent).not.toContain('Explicit pilot');expect(host.querySelector('[data-skeleton]')).not.toBeNull();
 });
 it('renders frozen resource evidence, named action/target and sends the exact independent confirmation',async()=>{
   const result=await openResource('consolidate_default');await click(t.review);
   expect(mocks.apply).toHaveBeenCalledWith('w','plan','resource-item',result.confirmation);
   const preview=renderToStaticMarkup(<I18nProvider locale="en" dict={en}>{mocks.confirm.mock.calls[0][0].content}</I18nProvider>);
   for(const text of ['Frozen migration document','Saved source excerpt','Research','Casey','Brian Research','project-1',en.scopeReview.confidential,en.scopeReview.private,en.scopeReview.readScope,en.scopeReview.editScope,en.scopeReview.futureMembers,t.warning,t.sourceFloor,t.floorWarning,result.confirmation.expiresAt])expect(preview).toContain(text);
   expect(preview).not.toContain('server diagnostic');
 });
 it('rejects expired resource confirmation even when canonical expiry is absent',async()=>{
   const result=await openResource();mocks.prepare.mockResolvedValue({...result,confirmation:{...result.confirmation,expiresAt:'2000-01-01T00:00:00.000Z'}});
   await click(t.review);expect(mocks.confirm).not.toHaveBeenCalled();expect(mocks.apply).not.toHaveBeenCalled();expect(host.textContent).toContain(en.workspaceAccess.reviewExpired);
 });
 it('aborts resource confirmation on focus and requires the newly returned confirmation after re-review',async()=>{
   const result=await openResource();let finish!:(value:boolean)=>void;
   mocks.confirm.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}));await click(t.review);
   const signal=mocks.confirm.mock.calls[0][0].signal;await act(async()=>window.dispatchEvent(new Event('focus')));expect(signal.aborted).toBe(true);
   await act(async()=>finish(true));expect(mocks.apply).not.toHaveBeenCalled();
   const fresh={...result,review:{...result.review,id:'new-review',payloadHash:'new-hash',version:'11'},confirmation:{...result.confirmation,reviewId:'new-review',payloadHash:'new-hash',expectedVersion:'11'}};mocks.prepare.mockResolvedValue(fresh);
   await click(t.review);expect(mocks.apply).toHaveBeenCalledWith('w','plan','resource-item',fresh.confirmation);
 });
 it.each(['stale','cancelled'])('never treats HTTP 200 resource %s as applied or keeps its approval for retry',async status=>{
   const result=await openResource();mocks.apply.mockResolvedValue({...result.item,kind:'resource',status,review:{...result.review,status}});await click(t.review);
   expect(host.textContent).toContain(t.scope_review_changed);expect(host.textContent).toContain(`${t.appliedCount}: 0 / 1`);expect(host.textContent).not.toContain(en.workspaceAccess.retryChange);
   await click(t.review);expect(mocks.prepare).toHaveBeenCalledTimes(2);
 });
 it('retries uncertain resource apply using the unchanged receipt without a new review',async()=>{
   const result=await openResource();mocks.apply.mockRejectedValueOnce(new Error('network'));await click(t.review);await click(en.workspaceAccess.retryChange);
   expect(mocks.prepare).toHaveBeenCalledTimes(1);expect(mocks.apply.mock.calls[0]).toEqual(mocks.apply.mock.calls[1]);expect(mocks.apply.mock.calls[1][3]).toEqual(result.confirmation);
 });
 it('blocks unsupported resource families and localizes source-floor refusal without raw codes',async()=>{
   const result=await openResource();mocks.detail.mockImplementation(async()=>protectedData({...plan(),items:[{...result.item,status:'blocked',diagnostic_code:'scope_review_action_unsupported'}]}));await act(async()=>invalidateSurfaceCache('workspace-access:w:admin:migration:plan:plan'));
   expect(host.textContent).toContain(t.scope_review_action_unsupported);await click(t.review);expect(mocks.prepare).not.toHaveBeenCalled();
   mocks.detail.mockImplementation(async()=>protectedData({...plan(),items:[result.item]}));await act(async()=>invalidateSurfaceCache('workspace-access:w:admin:migration:plan:plan'));
   mocks.prepare.mockRejectedValue(new Error('scope_review_source_floor_unsupported'));await click(t.review);expect(host.textContent).toContain(t.scope_review_source_floor_unsupported);expect(mocks.apply).not.toHaveBeenCalled();
 });
 it('localizes all supported blocker and migration error messages in all four dictionaries',()=>{
   for(const dict of [en,ja,zh,zhCN])for(const code of [...plan().blockers,'migration_expired','migration_actor_required','migration_busy','migration_not_active','migration_item_applied','scope_review_action_unsupported','migration_source_floor_review_required','scope_review_source_floor_unsupported','scope_review_changed','scope_review_expired','scope_review_impact_missing','scope_review_conflict'])expect(migrationMessage(code,dict.accessMigration)).toBeTruthy();
 });
});
