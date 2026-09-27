// @vitest-environment jsdom
import type { ProtectedProjection } from '@/lib/use-protected-projection';
import { act } from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceAccessOverview } from '@use-brian/shared';
import { WorkspaceAccessView } from '../workspace-access';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
import { ja } from '@/lib/i18n/dictionaries/ja';
import { zh } from '@/lib/i18n/dictionaries/zh';
import { zhCN } from '@/lib/i18n/dictionaries/zh-cn';
import { invalidateSurfaceCache, SurfaceCacheEvictionError } from '@/lib/surface-cache';
import { WORKSPACE_IDENTITY_REFRESH_EVENT } from '@/lib/workspace-identity-events';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const mocks=vi.hoisted(()=>({fetch:vi.fn(),history:vi.fn(),prepare:vi.fn(),save:vi.fn(),confirm:vi.fn(),settings:vi.fn(),viewer:{workspaceId:'workspace-fixture',me:{id:'member-fixture'}}}));
vi.mock('@/lib/workspace-context',()=>({useWorkspaceContext:()=>mocks.viewer}));
vi.mock('@/lib/surface-prefetch',()=>({workspaceAccessCacheKey:(w:string,u:string)=>`workspace-access:${w}:${u}`,workspaceAccessHistoryCacheKey:(w:string,u:string,k:string,r:string,a:string)=>`workspace-access:${w}:${u}:history:${k}:${r}:${a}`}));
vi.mock('@/lib/api/workspace-access',()=>({fetchWorkspaceAccess:mocks.fetch,fetchWorkspaceAccessHistory:mocks.history,prepareWorkspaceAccessCommand:mocks.prepare,saveWorkspaceAccessCommand:mocks.save,ORGANIZATION_CHANGED_EVENT:'brian:organization-changed'}));
vi.mock('@/lib/workspace-settings-events',()=>({openWorkspaceSettings:mocks.settings}));
vi.mock('@/components/ui/confirm-dialog',()=>({confirmDialog:mocks.confirm}));
vi.mock('@/components/chrome/surface-skeleton',()=>({SurfaceSkeletonFor:()=> <div data-skeleton/>}));
vi.mock('../scope-review',()=>({ScopeReviewPanel:({close}:{close:()=>void})=><button data-scope-review onClick={close}>Review fixture</button>}));
let root:Root,host:HTMLDivElement;
const t=en.workspaceAccess;
function fixture():ProtectedProjection<WorkspaceAccessOverview>{return{readiness:{ready:true,enforcementVersion:2,requiredEnforcementVersion:2,missingCapabilities:[]},validForMs:30_000,projectionDeadline:Date.now()+30_000,projectionMonotonicDeadline:performance.now()+30_000,workspaceId:'workspace-fixture',policyRevision:'15',classificationMode:'legacy',canAdminister:false,people:[{id:'member-fixture',name:'Riley',role:'member'}],teams:[{id:'research',name:'Research',directoryVisibility:'workspace',requestable:true,canManageMembers:false,canApprove:false,expandedPackage:false,memberIds:[],assistantIds:[],managerIds:[],managers:[]}],requests:[],grants:[]};}
async function render(){await act(async()=>root.render(<I18nProvider locale="en" dict={en}><WorkspaceAccessView/></I18nProvider>));}
async function click(label:string){const button=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()===label);expect(button).toBeDefined();await act(async()=>button!.click());}
beforeEach(()=>{mocks.history.mockReset();mocks.viewer.me.id='member-fixture';mocks.fetch.mockReset().mockResolvedValue(fixture());mocks.save.mockReset().mockResolvedValue(fixture());mocks.prepare.mockReset().mockImplementation(async(_workspaceId,command)=>({id:'review-fixture',payloadHash:'a'.repeat(64),command,changes:[],expiresAt:'2030-01-01T00:00:00Z',validForMs:30000,policyRevision:'15'}));mocks.confirm.mockReset().mockResolvedValue(true);mocks.settings.mockReset();invalidateSurfaceCache('workspace-access:');host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();invalidateSurfaceCache('workspace-access:');});
describe('[COMP:app-web/workspace-access] request and administration paths',()=>{
  it('pages requests independently, returns to newest and reviews an older request',async()=>{
    const data=fixture();data.nextRequestCursor='request-anchor';data.nextGrantCursor='grant-anchor'
    const older={...fixture(),kind:'requests',nextCursor:null,requests:[{id:'older',targetTeamId:'research',targetTeamName:'Research',requesterUserId:'member-fixture',beneficiaryKind:'member',beneficiaryId:'member-fixture',beneficiaryName:'Riley',reason:'Older request fixture',startsAt:'2020-01-01',expiresAt:null,requestExpiresAt:'2030-01-01',status:'pending',version:'1',payloadHash:'a'.repeat(64),approvalId:null,canDecide:false,canCancel:true}]}
    mocks.fetch.mockResolvedValue(data);mocks.history.mockResolvedValue(older)
    await render();await click(t.olderRequests)
    expect(mocks.history).toHaveBeenCalledWith('workspace-fixture','requests','request-anchor','15')
    expect(host.textContent).toContain('Older request fixture');expect(host.textContent).toContain(t.olderGrants)
    expect(host.textContent).not.toContain(t.olderRequests)
    await click(t.cancel)
    expect(mocks.prepare).toHaveBeenCalledWith('workspace-fixture',{type:'access.request.cancel',requestId:'older',expectedVersion:'1'},'15',expect.any(String))
    await click(t.olderRequests);await click(t.newestHistory)
    expect(host.textContent).not.toContain('Older request fixture');expect(host.textContent).toContain(t.olderRequests)
  });
  it('offers retry and restart when history cannot be read, and drops a late page after authority changes',async()=>{
    const data=fixture();data.nextGrantCursor='grant-anchor';mocks.fetch.mockResolvedValue(data)
    mocks.history.mockRejectedValueOnce(new Error('access_history_changed'))
    await render();await click(t.olderGrants);expect(host.textContent).toContain(t.historyChanged)
    const pageSection=[...host.querySelectorAll('section')].find(section=>section.textContent?.includes(t.historyChanged))!
    let finish!:(value:unknown)=>void;mocks.history.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
    const retry=[...pageSection.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent===t.reload)!
    await act(async()=>retry.click())
    mocks.fetch.mockRejectedValue(new SurfaceCacheEvictionError(new Error('not_found')))
    await act(async()=>window.dispatchEvent(new CustomEvent(WORKSPACE_IDENTITY_REFRESH_EVENT,{detail:{workspaceId:'workspace-fixture'}})))
    await act(async()=>finish({...fixture(),kind:'grants',nextCursor:null,grants:[{id:'secret',targetTeamName:'Old privileged record',status:'active',beneficiaryName:'Riley',startsAt:'2020-01-01',expiresAt:null,canRevoke:false}]}))
    expect(host.textContent).not.toContain('Old privileged record');expect(host.textContent).not.toContain(t.newestHistory)
  });
  it('shows current personal reach separately and keeps administrator settings read-only',async()=>{
    const data=fixture();data.canAdminister=true
    data.people=[{id:'member-fixture',name:'Riley',role:'member',access:{clearance:'internal',effectiveClearance:'internal',teamScopeMode:'legacy',readTeamIds:null,membershipTeamIds:null,hasUnlistedReadScope:false,hasUnlistedMembershipScope:false}},{id:'owner',name:'Casey',role:'owner',access:{clearance:'internal',effectiveClearance:'confidential',teamScopeMode:'legacy',readTeamIds:null,membershipTeamIds:null,hasUnlistedReadScope:false,hasUnlistedMembershipScope:false}}]
    mocks.fetch.mockResolvedValue(data);await render()
    expect(host.textContent).toContain(`${t.readReach}: ${t.allDepartments}`)
    expect(host.textContent).toContain(t.legacyHint)
    const editButtons=[...host.querySelectorAll('button')].filter(button=>button.textContent===t.editPerson)
    expect(editButtons).toHaveLength(1)
    expect(host.textContent).toContain(`${t.clearance}: ${t.confidential}`)
  });
  it('reviews the exact person settings and current policy before saving',async()=>{
    const data=fixture();data.canAdminister=true
    data.people[0].access={clearance:'internal',effectiveClearance:'internal',teamScopeMode:'assigned',readTeamIds:['research'],membershipTeamIds:[],hasUnlistedReadScope:false,hasUnlistedMembershipScope:false}
    mocks.fetch.mockResolvedValue(data);await render();await click(t.editPerson)
    await act(async()=>host.querySelector<HTMLButtonElement>(`button[aria-label="${t.clearance}"]`)!.click())
    const option=[...document.querySelectorAll<HTMLElement>('[role="option"]')].find(node=>node.textContent?.trim()===t.public)
    expect(option).toBeDefined();await act(async()=>option!.click())
    await click(t.savePerson)
    expect(mocks.prepare).toHaveBeenCalledWith('workspace-fixture',{type:'member.access.set',userId:'member-fixture',clearance:'public',teamScopeMode:'assigned',expectedPolicyRevision:'15'},'15',expect.any(String))
    expect(mocks.save).toHaveBeenCalledWith('workspace-fixture',{type:'access.command.apply',reviewId:'review-fixture',payloadHash:'a'.repeat(64)})
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({description:expect.stringContaining(`${t.internal} → ${t.public}`)}))
    expect(mocks.confirm.mock.calls[0][0].description).toContain(t.personChangeHint)
  });
  it('blocks an unready legacy migration and discards the editor on permission invalidation',async()=>{
    const data=fixture();data.canAdminister=true;data.readiness.ready=false
    data.people[0].access={clearance:'internal',effectiveClearance:'internal',teamScopeMode:'legacy',readTeamIds:[],membershipTeamIds:[],hasUnlistedReadScope:true,hasUnlistedMembershipScope:true}
    mocks.fetch.mockResolvedValue(data);await render();expect(host.textContent).toContain(t.unlistedScope);await click(t.editPerson)
    await act(async()=>host.querySelector<HTMLButtonElement>(`button[aria-label="${t.scopeMode}"]`)!.click())
    const option=[...document.querySelectorAll<HTMLElement>('[role="option"]')].find(node=>node.textContent?.trim()===t.assignedMode)
    expect(option).toBeDefined();await act(async()=>option!.click())
    const save=[...host.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent===t.savePerson)!
    expect(save.disabled).toBe(true);expect(mocks.save).not.toHaveBeenCalled()
    mocks.fetch.mockRejectedValue(new SurfaceCacheEvictionError(new Error('not_found')))
    await act(async()=>window.dispatchEvent(new CustomEvent(WORKSPACE_IDENTITY_REFRESH_EVENT,{detail:{workspaceId:'workspace-fixture'}})))
    expect(host.querySelector('form')).toBeNull();expect(host.textContent).not.toContain('Riley')
  });
  it('displays server-computed changes and retries a lost response with the same confirmed receipt',async()=>{
    const data=fixture();data.grants=[{status:'active',id:'grant',requestId:'request',targetTeamId:'research',targetTeamName:'Research',beneficiaryKind:'member',beneficiaryId:'member-fixture',beneficiaryName:'Riley',startsAt:'2020-01-01T00:00:00Z',expiresAt:null,revokedAt:null,approvedBy:'owner',canRevoke:true}]
    mocks.fetch.mockResolvedValue(data)
    mocks.prepare.mockResolvedValue({id:'immutable-review',payloadHash:'b'.repeat(64),validForMs:30000,changes:[{field:'clearance',before:[{kind:'code',value:'internal'}],after:[{kind:'code',value:'confidential'}]}],expiresAt:'2030-01-01T00:00:00Z'})
    mocks.save.mockRejectedValueOnce(new TypeError('Network failure'))
    await render();await click(t.revoke)
    const html=renderToStaticMarkup(<I18nProvider locale="en" dict={en}>{mocks.confirm.mock.calls[0][0].content}</I18nProvider>)
    expect(html).toContain(t.reviewBefore);expect(html).toContain(t.internal);expect(html).toContain(t.reviewAfter);expect(html).toContain(t.confidential)
    await click(t.retryChange)
    expect(mocks.prepare).toHaveBeenCalledTimes(1);expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(mocks.save).toHaveBeenCalledTimes(2)
    for(const call of mocks.save.mock.calls)expect(call).toEqual(['workspace-fixture',{type:'access.command.apply',reviewId:'immutable-review',payloadHash:'b'.repeat(64)}])
  });
  it('does not apply a pending confirmation after permission invalidation, even if a late confirm resolves true',async()=>{
    const data=fixture();data.grants=[{status:'active',id:'grant',requestId:'request',targetTeamId:'research',targetTeamName:'Research',beneficiaryKind:'member',beneficiaryId:'member-fixture',beneficiaryName:'Riley',startsAt:'2020-01-01T00:00:00Z',expiresAt:null,revokedAt:null,approvedBy:'owner',canRevoke:true}]
    mocks.fetch.mockResolvedValue(data)
    let finish:(confirmed:boolean)=>void=()=>{}
    mocks.confirm.mockImplementation(()=>new Promise<boolean>(resolve=>{finish=resolve}))
    await render();await click(t.revoke)
    const signal=mocks.confirm.mock.calls[0][0].signal as AbortSignal
    expect(signal.aborted).toBe(false)
    mocks.fetch.mockRejectedValue(new SurfaceCacheEvictionError(new Error('not_found')))
    await act(async()=>window.dispatchEvent(new CustomEvent(WORKSPACE_IDENTITY_REFRESH_EVENT,{detail:{workspaceId:'workspace-fixture'}})))
    expect(signal.aborted).toBe(true)
    await act(async()=>finish(true))
    expect(mocks.save).not.toHaveBeenCalled();expect(host.textContent).not.toContain('Research')
  });
  it('gives administrators an explicit legacy-review entry and a way back',async()=>{
    await render();expect(host.textContent).not.toContain(t.reviewData)
    const data=fixture();data.canAdminister=true;mocks.fetch.mockResolvedValue(data)
    await act(async()=>invalidateSurfaceCache('workspace-access:'));await click(t.reviewData)
    expect(host.querySelector('[data-scope-review]')).not.toBeNull()
    await act(async()=>host.querySelector<HTMLButtonElement>('[data-scope-review]')!.click())
    expect(host.textContent).toContain(t.title)
  });
  it.each(['blocked','missing'] as const)('explains %s readiness and keeps recovery controls usable',async mode=>{
    const data=fixture();data.canAdminister=true
    if(mode==='blocked')data.readiness.ready=false
    else delete (data as Partial<WorkspaceAccessOverview>).readiness
    data.requests=[{id:'request',targetTeamId:'research',targetTeamName:'Research',requesterUserId:'other-member',beneficiaryKind:'member',beneficiaryId:'other-member',beneficiaryName:'Casey',reason:'Review requirements',startsAt:'2030-01-01T00:00:00Z',expiresAt:'2030-01-31T00:00:00Z',requestExpiresAt:'2030-01-15T00:00:00Z',status:'pending',version:'1',payloadHash:'a'.repeat(64),approvalId:'approval',canDecide:true,canCancel:true}]
    data.grants=[{status:'active',id:'grant',requestId:'approved-request',targetTeamId:'research',targetTeamName:'Research',beneficiaryKind:'member',beneficiaryId:'member-fixture',beneficiaryName:'Riley',startsAt:'2020-01-01T00:00:00Z',expiresAt:null,revokedAt:null,approvedBy:'owner',canRevoke:true}]
    mocks.fetch.mockResolvedValue(data);await render()
    expect(host.querySelector('[role="status"]')?.textContent).toBe(t.notReady)
    const button=(label:string)=>[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()===label)!
    expect(button(t.requestAccess).disabled).toBe(true);expect(button(t.approve).disabled).toBe(true)
    expect(button(t.reject).disabled).toBe(false);expect(button(t.cancel).disabled).toBe(false)
    expect(button(t.revoke).disabled).toBe(false)
    await click(t.requestAccess);expect(host.querySelector('form')).toBeNull();expect(mocks.save).not.toHaveBeenCalled()
    await click(t.organization);expect(mocks.settings).toHaveBeenCalledWith('ws-organization')
    await click(t.revoke);expect(mocks.prepare).toHaveBeenCalledWith('workspace-fixture',{type:'access.grant.revoke',grantId:'grant',reason:t.revoke},'15',expect.any(String))
  });
  it('explains a server readiness refusal after a previously ready review',async()=>{
    const data=fixture();data.requests=[{id:'request',targetTeamId:'research',targetTeamName:'Research',requesterUserId:'other-member',beneficiaryKind:'member',beneficiaryId:'other-member',beneficiaryName:'Casey',reason:'Review requirements',startsAt:'2030-01-01T00:00:00Z',expiresAt:'2030-01-31T00:00:00Z',requestExpiresAt:'2030-01-15T00:00:00Z',status:'pending',version:'1',payloadHash:'a'.repeat(64),approvalId:'approval',canDecide:true,canCancel:false}]
    mocks.fetch.mockResolvedValue(data);mocks.save.mockRejectedValue(new Error('departmental_enforcement_incomplete'))
    await render();await click(t.approve);expect(host.querySelector('[role="alert"]')?.textContent).toBe(t.notReady)
  });
  it('lets a member request thirty days of read-only access for themselves',async()=>{
    await render();expect(host.textContent).not.toContain(t.configureTeams);expect(host.textContent).not.toContain(t.adminHint);
    await click(t.requestAccess);expect(host.textContent).toContain(t.readOnly);expect(host.querySelector('select')).toBeNull();
    const reason=host.querySelector('textarea')!;
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(reason,'Review launch requirements');reason.dispatchEvent(new Event('input',{bubbles:true}));});
    await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    expect(mocks.prepare).toHaveBeenCalledWith('workspace-fixture',{type:'access.request.create',targetTeamId:'research',beneficiaryKind:'member',beneficiaryId:'member-fixture',reason:'Review launch requirements',days:30,ongoing:false},'15',expect.any(String));
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({description:expect.stringContaining(t.readOnly)}));
  });
  it('links administrators to department setup and the organization chart',async()=>{
    mocks.fetch.mockResolvedValue({...fixture(),canAdminister:true});await render();expect(host.textContent).toContain(t.adminHint);
    await click(t.configureTeams);expect(mocks.settings).toHaveBeenCalledWith('ws-teams');
    await click(t.organization);expect(mocks.settings).toHaveBeenCalledWith('ws-organization');
    await click(t.edit);expect(host.textContent).toContain(t.managerSave);expect(host.textContent).toContain(t.manageMembers);
  });
  it('submits the exact reviewed request version and policy revision, and explains stale reviews',async()=>{
    const data=fixture();data.requests=[{id:'request',targetTeamId:'research',targetTeamName:'Research',requesterUserId:'other-member',beneficiaryKind:'member',beneficiaryId:'other-member',beneficiaryName:'Casey',reason:'Review requirements',startsAt:'2030-01-01T00:00:00Z',expiresAt:'2030-01-31T00:00:00Z',requestExpiresAt:'2030-01-15T00:00:00Z',status:'pending',version:'1',payloadHash:'a'.repeat(64),approvalId:'approval',canDecide:true,canCancel:false}];
    mocks.fetch.mockResolvedValue(data);mocks.save.mockRejectedValue(new Error('request_review_stale'));await render();await click(t.approve);
    expect(mocks.prepare).toHaveBeenCalledWith('workspace-fixture',{type:'access.request.decide',requestId:'request',expectedVersion:'1',payloadHash:'a'.repeat(64),policyRevision:'15',decision:'approved'},'15',expect.any(String));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(t.stale);
    expect(mocks.confirm.mock.calls[0][0].description).toContain('Casey');
  });
  it('lets an administrator refresh an already assigned pending reviewer',async()=>{
    const data=fixture();data.canAdminister=true;data.requests=[{id:'request',targetTeamId:'research',targetTeamName:'Research',requesterUserId:'other-member',beneficiaryKind:'member',beneficiaryId:'other-member',beneficiaryName:'Casey',reason:'Review requirements',startsAt:'2030-01-01T00:00:00Z',expiresAt:'2030-01-31T00:00:00Z',requestExpiresAt:'2030-01-15T00:00:00Z',status:'pending',version:'1',payloadHash:'a'.repeat(64),approvalId:'existing-card',canDecide:false,canCancel:false}];
    mocks.fetch.mockResolvedValue(data);await render();await click(t.assign);
    expect(mocks.prepare).toHaveBeenCalledWith('workspace-fixture',{type:'access.request.assign',requestId:'request'},'15',expect.any(String));
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({description:expect.stringContaining('Research')}));
  });
  it('uses server grant status when the browser clock is incorrect',async()=>{
    const clock=vi.spyOn(Date,'now').mockReturnValue(Date.UTC(2099,0,1));
    try {
      const data=fixture();data.grants=[{status:'active',id:'grant',requestId:'request',targetTeamId:'research',targetTeamName:'Research',beneficiaryKind:'member',beneficiaryId:'member-fixture',beneficiaryName:'Riley',startsAt:'2020-01-01T00:00:00Z',expiresAt:'2020-02-01T00:00:00Z',revokedAt:null,approvedBy:'owner',canRevoke:true}];
      mocks.fetch.mockResolvedValue(data);await render();
      expect(host.textContent).toContain(`Research · ${t.active}`);expect(host.textContent).not.toContain(`Research · ${t.expired}`);
    } finally {clock.mockRestore();}
  });
  it('does not send a mutation when the concrete confirmation is cancelled',async()=>{
    const data=fixture();data.grants=[{status:'active',id:'grant',requestId:'request',targetTeamId:'research',targetTeamName:'Research',beneficiaryKind:'member',beneficiaryId:'member-fixture',beneficiaryName:'Riley',startsAt:'2020-01-01T00:00:00Z',expiresAt:null,revokedAt:null,approvedBy:'owner',canRevoke:true}];mocks.fetch.mockResolvedValue(data);mocks.confirm.mockResolvedValue(false);await render();await click(t.revoke);expect(mocks.save).not.toHaveBeenCalled();
  });
  it('purges request reasons and open forms when access is revoked',async()=>{
    await render();await click(t.requestAccess);mocks.fetch.mockRejectedValue(new SurfaceCacheEvictionError(new Error('not_found')));
    await act(async()=>window.dispatchEvent(new CustomEvent(WORKSPACE_IDENTITY_REFRESH_EVENT,{detail:{workspaceId:'workspace-fixture'}})));
    expect(host.textContent).not.toContain('Research');expect(host.querySelector('form')).toBeNull();expect(host.textContent).toContain(t.loadError);
  });
  it('provides the same complete controls in all four locales',()=>{
    for(const dict of [ja,zh,zhCN])expect(Object.keys(dict.workspaceAccess)).toEqual(Object.keys(t));
    for(const dict of [en,ja,zh,zhCN])for(const value of Object.values(dict.workspaceAccess)){expect(value.trim()).not.toBe('');expect(value).not.toContain('—');}
  });
});
