// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const ports=vi.hoisted(()=>({path:'/w/ws/projects/one',list:vi.fn(),push:vi.fn()}));
vi.mock('next/navigation',()=>({usePathname:()=>ports.path,useRouter:()=>({push:ports.push})}));
vi.mock('@/lib/api/context-scopes',()=>({listContextProjects:ports.list}));
vi.mock('@/lib/workspace-context',()=>({useWorkspaceContext:()=>({workspaceId:'ws'})}));
vi.mock('@/components/operator/operator-topbar',()=>({OperatorTopbar:({center}:{center:React.ReactNode})=><header>{center}</header>}));
vi.mock('@/lib/i18n/client',async()=>{const {en}=await import('@/lib/i18n/dictionaries/en');return {useT:()=>en};});
import { ProjectsSidebarPanel, ProjectsTopbar } from '../projects-navigation';
import { resetSurfaceCache } from '@/lib/surface-cache';
let host:HTMLDivElement,root:Root;
beforeEach(()=>{
 (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
 resetSurfaceCache();vi.clearAllMocks();ports.path='/w/ws/projects/one';
 ports.list.mockResolvedValue([{id:'one',name:'Atlas',status:'active'},{id:'two',name:'Beacon',status:'archived'}]);
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(()=>{act(()=>root.unmount());host.remove();});
describe('[COMP:app-web/projects-navigation] project chrome',()=>{
 it('shares the registry request, shows current project in the top bar and highlights exactly one sidebar link',async()=>{
  await act(async()=>root.render(<><ProjectsSidebarPanel workspaceId="ws"/><ProjectsTopbar/></>));
  expect(ports.list).toHaveBeenCalledTimes(1);
  expect(host.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  expect(host.querySelector('[aria-current="page"]')?.getAttribute('href')).toBe('/w/ws/projects/one');
  expect(host.querySelector('header')?.textContent).toContain('Atlas');
  expect(host.textContent).toContain('Archived');expect(host.textContent).toContain('Beacon');
 });
 it('shows All projects as the route selection at the browser root',async()=>{
  ports.path='/w/ws/projects';await act(async()=>root.render(<><ProjectsSidebarPanel workspaceId="ws"/><ProjectsTopbar/></>));
  expect(host.querySelector('[aria-current="page"]')?.textContent).toContain('All Projects');
  expect(host.querySelector('header')?.textContent).toContain('All Projects');
 });
 it('offers retry rather than an empty registry when the read fails',async()=>{
  ports.list.mockRejectedValueOnce(new Error('offline'));await act(async()=>root.render(<ProjectsSidebarPanel workspaceId="ws"/>));
  expect(host.querySelector('[role="alert"]')).toBeTruthy();
  await act(async()=>host.querySelector('button')?.click());
  expect(host.textContent).toContain('Atlas');expect(host.querySelector('[role="alert"]')).toBeNull();
 });
});
