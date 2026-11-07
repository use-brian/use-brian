// @vitest-environment jsdom
import React, { act } from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mocks = vi.hoisted(() => ({ctx:{workspaceId:'ws',role:'owner',me:{id:'viewer'}},list:vi.fn(),create:vi.fn(),rotate:vi.fn(),revoke:vi.fn(),confirm:vi.fn()}));
vi.mock('@/lib/workspace-context',()=>({useWorkspaceContext:()=>mocks.ctx}));
vi.mock('@/lib/api/external-approval-sources',async importOriginal => ({...await importOriginal<object>(),listExternalApprovalSources:mocks.list,createExternalApprovalSource:mocks.create,rotateExternalApprovalSource:mocks.rotate,revokeExternalApprovalSource:mocks.revoke}));
vi.mock('@/lib/api/studio',()=>({listAssistants:async()=>[{id:'assistant',name:'Assistant'}]}));
vi.mock('@/lib/api/workflow',()=>({listWorkspaceMemberOptions:async()=>[{id:'other-human',label:'Other human'}]}));
vi.mock('@/components/ui/confirm-dialog',()=>({confirmDialog:mocks.confirm}));
vi.mock('@/components/chrome/surface-skeleton',()=>({SurfaceSkeletonFor:()=> <div data-skeleton /> }));
// Deterministic primitive stand-in: exercise values without native select or portal geometry.
vi.mock('@/components/ui/select',()=>({Select:({children,onValueChange}:React.PropsWithChildren<{onValueChange:(s:string)=>void}>)=><div onClick={()=>onValueChange('assistant')} onDoubleClick={()=>onValueChange('other-human')}>{children}</div>,SelectTrigger:({children,...props}:React.PropsWithChildren)=> <button type="button" {...props}>{children}</button>,SelectValue:()=>null,SelectContent:()=>null,SelectItem:()=>null}));
import {ExternalApprovalsSection} from '../external-approvals-section';
import {ExternalApprovalSourceError} from '@/lib/api/external-approval-sources';
import {I18nProvider} from '@/lib/i18n/client';
import {en} from '@/lib/i18n/dictionaries/en';
import {resetSurfaceCache,readSurfaceCache} from '@/lib/surface-cache';
import {externalApprovalSourcesCacheKey} from '@/lib/surface-prefetch';
import {applySpineEventToSurfaceCache} from '@/lib/surface-cache-invalidation';
import {WORKSPACE_IDENTITY_REFRESH_EVENT} from '@/lib/workspace-identity-events';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLDivElement,root:Root;
const source={id:'source',name:'Registered app',assistantId:'assistant',approverUserId:'other-human',prefix:'prefix',channelType:'web',channelId:'other-human',revokedAt:null};
const settle=()=>new Promise(r=>setTimeout(r,0));
async function render(){await act(async()=>{root.render(<I18nProvider locale="en" dict={en}><ExternalApprovalsSection /></I18nProvider>);await settle();});}
async function click(text:string){const button=[...host.querySelectorAll('button')].find(b=>b.textContent===text)!;expect(button).toBeTruthy();await act(async()=>{button.click();await settle();});}
async function fill(){await act(async()=>{const input=host.querySelector('input')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'Draft app');input.dispatchEvent(new Event('input',{bubbles:true}));host.querySelector('[aria-label="Assistant"]')!.dispatchEvent(new MouseEvent('click',{bubbles:true}));});await act(async()=>{host.querySelector('[aria-label="Human approver"]')!.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));});}
beforeEach(()=>{vi.clearAllMocks();resetSurfaceCache();mocks.ctx={workspaceId:'ws',role:'owner',me:{id:'viewer'}};mocks.list.mockResolvedValue([]);mocks.confirm.mockResolvedValue(true);mocks.create.mockResolvedValue({source,token:'synthetic-created'});mocks.rotate.mockResolvedValue({source,token:'synthetic-rotated'});mocks.revoke.mockResolvedValue(undefined);host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();resetSurfaceCache();});
describe('[COMP:app-web/external-approvals] registration settings',()=>{
 it.each(['owner','admin'])('allows %s to choose another human and reveal/dismiss without caching',async role=>{mocks.ctx.role=role;await render();await fill();await click(en.externalApprovals.create);expect(mocks.create).toHaveBeenCalledWith('ws',{name:'Draft app',assistantId:'assistant',approverUserId:'other-human',notification:'web'});expect(host.textContent).toContain('synthetic-created');expect(JSON.stringify(readSurfaceCache(externalApprovalSourcesCacheKey('ws','viewer')))).not.toContain('synthetic-created');await click(en.externalApprovals.dismiss);expect(host.textContent).not.toContain('synthetic-created');});
 it('hides admin controls from members',async()=>{mocks.ctx.role='member';await render();expect(host.textContent).toContain(en.externalApprovals.adminOnly);expect(mocks.list).not.toHaveBeenCalled();});
 it('preserves the draft on failure and permits retry',async()=>{mocks.create.mockRejectedValueOnce(new Error('offline'));await render();await fill();await click(en.externalApprovals.create);expect(host.querySelector('input')?.value).toBe('Draft app');expect(host.textContent).toContain(en.externalApprovals.failed);await click(en.externalApprovals.create);expect(host.textContent).toContain('synthetic-created');});
 it.each([[409,'verifiedUnavailable'],[404,'unavailable']] as const)('explains HTTP %s and offers non-destructive refresh',async(status,key)=>{
   mocks.create.mockRejectedValueOnce(new ExternalApprovalSourceError(status));await render();await fill();await click(en.externalApprovals.create);
   expect(host.textContent).toContain(en.externalApprovals[key]);const before=mocks.list.mock.calls.length;await click(en.externalApprovals.retry);
   expect(mocks.list.mock.calls.length).toBeGreaterThan(before);expect(host.querySelector('input')?.value).toBe('Draft app');
 });
 it('rotates and revokes with confirmation',async()=>{mocks.list.mockResolvedValue([source]);await render();await click(en.externalApprovals.rotate);expect(mocks.rotate).toHaveBeenCalledWith('ws','source');expect(host.textContent).toContain('synthetic-rotated');await click(en.externalApprovals.dismiss);await click(en.externalApprovals.revoke);expect(mocks.revoke).toHaveBeenCalledWith('ws','source');expect(mocks.confirm).toHaveBeenCalledTimes(2);});
 it('ignores an issuance completing after workspace switch',async()=>{let resolve!:(v:unknown)=>void;mocks.create.mockReturnValue(new Promise(r=>resolve=r));await render();await fill();await click(en.externalApprovals.create);mocks.ctx.workspaceId='next';await render();await act(async()=>{resolve({source,token:'late-credential'});await settle();});expect(host.textContent).not.toContain('late-credential');expect(host.querySelector('input')?.value).toBe('');expect(JSON.stringify(readSurfaceCache(externalApprovalSourcesCacheKey('next','viewer')))).not.toContain('late-credential');});
 it('refreshes on workspace_config identity signals',async()=>{await render();const calls=mocks.list.mock.calls.length;await act(async()=>{applySpineEventToSurfaceCache(WORKSPACE_IDENTITY_REFRESH_EVENT,{workspaceId:'ws'},'ws');await settle();});expect(mocks.list.mock.calls.length).toBeGreaterThan(calls);});
});
