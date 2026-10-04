// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const ports=vi.hoisted(()=>({get:vi.fn(),push:vi.fn(),stash:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:ports.push})}));
vi.mock('@/lib/api/context-scopes',()=>({getProjectContent:ports.get}));
vi.mock('@/lib/chat-handoff',()=>({stashChatHandoff:ports.stash,personalChatHandoffPath:()=>'/fresh-chat'}));
vi.mock('@/components/ui/searchable-select',()=>({SearchableSelect:()=>null}));
vi.mock('@/lib/i18n/client',async()=>{const {en}=await import('@/lib/i18n/dictionaries/en');return {useT:()=>en};});
import { ProjectContent } from '../project-content';
import { resetSurfaceCache } from '@/lib/surface-cache';
let host:HTMLDivElement,root:Root;
const project={id:'project',workspaceId:'workspace',name:'Atlas',normalizedName:'atlas',description:null,icon:null,status:'active' as const,entityId:null};
const row={key:'task:one',id:'one',title:'Finish the prototype',snippet:'Review the draft',kind:'tasks',status:'blocked',updatedAt:null,target:{type:'brain',id:'one',primitive:'tasks'}};
const mount=async(status:'active'|'archived'='active')=>{await act(async()=>root.render(<ProjectContent project={{...project,status}} assistants={[{id:'assistant',name:'Brian'}]}/>));};
const click=async(label:string)=>{const button=Array.from(host.querySelectorAll('button')).find(row=>row.textContent===label)!;await act(async()=>button.click());};
beforeEach(()=>{
 (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
 resetSurfaceCache();vi.clearAllMocks();ports.get.mockResolvedValue({items:[row],nextOffset:null});ports.stash.mockReturnValue('request');
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(()=>{act(()=>root.unmount());host.remove();});
describe('[COMP:app-web/project-content] project home',()=>{
 it('renders actual linked tasks with status and switches resource views',async()=>{
  await mount();expect(host.textContent).toContain('Finish the prototype');expect(host.textContent).toContain('Blocked');
  expect(host.querySelector('a')?.getAttribute('href')).toContain('one');
  await click('Knowledge');expect(ports.get).toHaveBeenLastCalledWith('workspace','project','knowledge','',0);
 });
 it('launches a fresh project-context draft without auto-sending',async()=>{
  await mount();await click('What should happen next?');
  expect(ports.stash).toHaveBeenCalledWith(expect.objectContaining({contextProjectId:'project',draftOnly:true,assistantId:'assistant'}));
  expect(ports.push).toHaveBeenCalledWith('/fresh-chat');
 });
 it('keeps archived records readable and disables new project chat',async()=>{
  await mount('archived');expect(host.textContent).toContain(row.title);await click('What should happen next?');expect(ports.stash).not.toHaveBeenCalled();
 });
 it('shows retry on failure instead of a false empty result',async()=>{
  ports.get.mockRejectedValueOnce(new Error('unavailable'));await mount();expect(host.querySelector('[role="alert"]')).toBeTruthy();
  expect(host.textContent).not.toContain('No linked content');await click('Try again');expect(host.textContent).toContain(row.title);
 });
 it('paginates then resets to the first page when changing views',async()=>{
  ports.get.mockResolvedValueOnce({items:[row],nextOffset:30});await mount();await click('Next');
  expect(ports.get).toHaveBeenLastCalledWith('workspace','project','work','',30);
  await click('Recent');expect(ports.get).toHaveBeenLastCalledWith('workspace','project','recent','',0);
 });
});
