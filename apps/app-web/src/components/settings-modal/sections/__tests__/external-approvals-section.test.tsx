// @vitest-environment jsdom
import React, { act } from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mocks = vi.hoisted(() => ({ctx:{workspaceId:'ws',role:'owner',me:{id:'viewer'}},list:vi.fn(),destinations:vi.fn(),assistants:vi.fn(),members:vi.fn(),create:vi.fn(),rotate:vi.fn(),revoke:vi.fn(),confirm:vi.fn()}));
vi.mock('@/lib/workspace-context',()=>({useWorkspaceContext:()=>mocks.ctx}));
vi.mock('@/lib/api/external-approval-sources',async importOriginal => ({...await importOriginal<object>(),listExternalApprovalSources:mocks.list,listExternalApprovalDestinations:mocks.destinations,createExternalApprovalSource:mocks.create,rotateExternalApprovalSource:mocks.rotate,revokeExternalApprovalSource:mocks.revoke}));
vi.mock('@/lib/api/studio',()=>({listAssistants:mocks.assistants}));
vi.mock('@/lib/api/workflow',()=>({listWorkspaceMemberOptions:mocks.members}));
vi.mock('@/components/ui/confirm-dialog',()=>({confirmDialog:mocks.confirm}));
vi.mock('@/components/chrome/surface-skeleton',()=>({SurfaceSkeletonFor:()=> <div data-skeleton /> }));
// Deterministic primitive stand-in: exercise values without native select or portal geometry.
vi.mock('@/components/ui/select',()=>({Select:({children,onValueChange,disabled}:React.PropsWithChildren<{onValueChange:(s:string)=>void;disabled:boolean}>)=><div onClick={e=>{const value=(e.target as HTMLElement).closest('[data-option]')?.getAttribute('data-option');if(value && !disabled)onValueChange(value);}}>{children}</div>,SelectTrigger:({children,...props}:React.PropsWithChildren)=> <button type="button" {...props}>{children}</button>,SelectValue:()=>null,SelectContent:({children}:React.PropsWithChildren)=><div>{children}</div>,SelectItem:({value,children}:{value:string;children:React.ReactNode})=><button type="button" data-option={value}>{children}</button>}));
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
async function choose(value:string){await act(async()=>{host.querySelector<HTMLButtonElement>(`[data-option="${value}"]`)!.click();await settle();});}
async function fill(){await act(async()=>{const input=host.querySelector('input')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'Draft app');input.dispatchEvent(new Event('input',{bubbles:true}));});await choose('assistant');await choose('destination');}
const destination={id:'destination',sessionId:'session',assistantId:'assistant',channelType:'web',channelId:'chat',label:'Accessible web conversation'};

beforeEach(()=>{vi.clearAllMocks();resetSurfaceCache();mocks.ctx={workspaceId:'ws',role:'owner',me:{id:'viewer'}};mocks.list.mockResolvedValue([]);mocks.assistants.mockResolvedValue([{id:'assistant',name:'Assistant'},{id:'second',name:'Second assistant'}]);mocks.destinations.mockResolvedValue({destinations:[destination],connections:[]});mocks.confirm.mockResolvedValue(true);mocks.create.mockResolvedValue({source,token:'synthetic-created'});mocks.rotate.mockResolvedValue({source,token:'synthetic-rotated'});mocks.revoke.mockResolvedValue(undefined);host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();resetSurfaceCache();});
describe('[COMP:app-web/external-approvals] registration settings',()=>{
 it.each(['owner','admin'])('allows %s to choose an explicit conversation and reveal/dismiss without caching',async role=>{mocks.ctx.role=role;await render();await fill();await click(en.externalApprovals.create);expect(mocks.create).toHaveBeenCalledWith('ws',{name:'Draft app',assistantId:'assistant',destinationId:'destination'});expect(host.textContent).toContain('synthetic-created');expect(mocks.members).not.toHaveBeenCalled();expect(host.textContent).toContain(en.externalApprovals.audiencePolicy);expect(JSON.stringify(readSurfaceCache(externalApprovalSourcesCacheKey('ws','viewer')))).not.toContain('synthetic-created');await click(en.externalApprovals.dismiss);expect(host.textContent).not.toContain('synthetic-created');});
 it('hides admin controls from members',async()=>{mocks.ctx.role='member';await render();expect(host.textContent).toContain(en.externalApprovals.adminOnly);expect(mocks.list).not.toHaveBeenCalled();expect(mocks.destinations).not.toHaveBeenCalled();});
 it('preserves the draft on failure and permits retry',async()=>{mocks.create.mockRejectedValueOnce(new Error('offline'));await render();await fill();await click(en.externalApprovals.create);expect(host.querySelector('input')?.value).toBe('Draft app');expect(host.textContent).toContain(en.externalApprovals.failed);await click(en.externalApprovals.create);expect(host.textContent).toContain('synthetic-created');});
 it.each([[409,'destinationChanged'],[404,'unavailable']] as const)('explains HTTP %s and offers non-destructive refresh',async(status,key)=>{
   mocks.create.mockRejectedValueOnce(new ExternalApprovalSourceError(status));await render();await fill();await click(en.externalApprovals.create);
   expect(host.textContent).toContain(en.externalApprovals[key]);const before=mocks.list.mock.calls.length;await click(en.externalApprovals.retry);
   expect(mocks.list.mock.calls.length).toBeGreaterThan(before);expect(host.querySelector('input')?.value).toBe('Draft app');
 });
 it('rotates and revokes with confirmation',async()=>{mocks.list.mockResolvedValue([source]);await render();await click(en.externalApprovals.rotate);expect(mocks.rotate).toHaveBeenCalledWith('ws','source');expect(host.textContent).toContain('synthetic-rotated');await click(en.externalApprovals.dismiss);await click(en.externalApprovals.revoke);expect(mocks.revoke).toHaveBeenCalledWith('ws','source');expect(mocks.confirm).toHaveBeenCalledTimes(2);});
 it('ignores an issuance completing after workspace switch',async()=>{let resolve!:(v:unknown)=>void;mocks.create.mockReturnValue(new Promise(r=>resolve=r));await render();await fill();await click(en.externalApprovals.create);mocks.ctx.workspaceId='next';await render();await act(async()=>{resolve({source,token:'late-credential'});await settle();});expect(host.textContent).not.toContain('late-credential');expect(host.querySelector('input')?.value).toBe('');expect(JSON.stringify(readSurfaceCache(externalApprovalSourcesCacheKey('next','viewer')))).not.toContain('late-credential');});
 it('refreshes on workspace_config identity signals',async()=>{await render();const calls=mocks.list.mock.calls.length;await act(async()=>{applySpineEventToSurfaceCache(WORKSPACE_IDENTITY_REFRESH_EVENT,{workspaceId:'ws'},'ws');await settle();});expect(mocks.list.mock.calls.length).toBeGreaterThan(calls);});
 it('lists unavailable connections with explanations and accessible web chats without member lookup',async()=>{
   mocks.destinations.mockResolvedValue({destinations:[destination],connections:[{id:'one',label:'Connected conversation channel',available:false,reason:'no_conversation'},{id:'two',label:'Connected unsupported channel',available:false,reason:'unsupported_transport'}]});
   await render();await choose('assistant');expect(host.textContent).toContain(destination.label);expect(host.textContent).toContain(en.externalApprovals.noConversation);expect(host.textContent).toContain(en.externalApprovals.unsupportedTransport);expect(mocks.members).not.toHaveBeenCalled();
 });
 it('explains empty destinations and prevents registration',async()=>{
   mocks.destinations.mockResolvedValue({destinations:[],connections:[]});await render();await choose('assistant');expect(host.textContent).toContain(en.externalApprovals.noDestinations);expect([...host.querySelectorAll('button')].find(b=>b.textContent===en.externalApprovals.create)?.disabled).toBe(true);
 });
 it.each([[401,'signInAgain'],[403,'accessDenied'],[409,'destinationChanged']] as const)('distinguishes destination loading HTTP %s',async(status,key)=>{
   mocks.destinations.mockRejectedValueOnce(new ExternalApprovalSourceError(status));await render();await choose('assistant');expect(host.textContent).toContain(en.externalApprovals[key]);await click(en.externalApprovals.refreshDestinations);expect(host.textContent).toContain(destination.label);
 });
 it('clears the destination on assistant switch and ignores a late former-assistant response',async()=>{
   let resolve!:(v:unknown)=>void;mocks.destinations.mockReturnValueOnce(new Promise(r=>resolve=r)).mockResolvedValueOnce({destinations:[{...destination,id:'second-destination',assistantId:'second',label:'Second conversation'}],connections:[]});
   await render();await choose('assistant');await choose('second');await act(async()=>{resolve({destinations:[destination],connections:[]});await settle();});
   expect(host.textContent).toContain('Second conversation');expect(host.textContent).not.toContain(destination.label);expect([...host.querySelectorAll('button')].find(b=>b.textContent===en.externalApprovals.create)?.disabled).toBe(true);
 });
 it('cannot submit a destination left over from a different assistant',async()=>{
   await render();await fill();await choose('second');expect([...host.querySelectorAll('button')].find(b=>b.textContent===en.externalApprovals.create)?.disabled).toBe(true);expect(mocks.create).not.toHaveBeenCalled();
 });
 it('blocks a stale assistant after identity refresh removes it',async()=>{
   await render();await fill();mocks.assistants.mockResolvedValue([]);await act(async()=>{applySpineEventToSurfaceCache(WORKSPACE_IDENTITY_REFRESH_EVENT,{workspaceId:'ws'},'ws');await settle();});
   expect([...host.querySelectorAll('button')].find(b=>b.textContent===en.externalApprovals.create)?.disabled).toBe(true);expect(host.querySelector('input')?.value).toBe('Draft app');
 });
 it('preserves cached content and draft offline, blocks stale submission, and recovers online',async()=>{
   await render();await fill();mocks.destinations.mockRejectedValueOnce(new TypeError('unsafe-network-detail'));await click(en.externalApprovals.refreshDestinations);
   expect(host.textContent).toContain(destination.label);expect(host.textContent).toContain(en.externalApprovals.loadFailed);expect(host.textContent).not.toContain('unsafe-network-detail');expect(host.querySelector('input')?.value).toBe('Draft app');expect([...host.querySelectorAll('button')].find(b=>b.textContent===en.externalApprovals.create)?.disabled).toBe(true);
   await act(async()=>{window.dispatchEvent(new Event('online'));await settle();});await click(en.externalApprovals.create);expect(mocks.create).toHaveBeenCalledTimes(1);
 });
 it.each(['workspace','viewer','role'])('clears a revealed secret across %s lifetime changes',async boundary=>{
   await render();await fill();await click(en.externalApprovals.create);if(boundary==='workspace')mocks.ctx.workspaceId='next';if(boundary==='viewer')mocks.ctx.me.id='next';if(boundary==='role')mocks.ctx.role='member';await render();expect(host.textContent).not.toContain('synthetic-created');
 });
 it('shows legacy identifiers without fetching people and keeps read-only binding details',async()=>{
   mocks.list.mockResolvedValue([source]);await render();expect(host.textContent).toContain(en.externalApprovals.legacyApprover);expect(host.textContent).toContain(source.approverUserId);expect(mocks.members).not.toHaveBeenCalled();
 });
 it('does not rotate or revoke if confirmation is declined',async()=>{
   mocks.list.mockResolvedValue([source]);mocks.confirm.mockResolvedValue(false);await render();await click(en.externalApprovals.rotate);await click(en.externalApprovals.revoke);expect(mocks.rotate).not.toHaveBeenCalled();expect(mocks.revoke).not.toHaveBeenCalled();
 });

});
