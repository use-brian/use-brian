// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {LegacyKnowledgeBindings} from '../legacy-knowledge-bindings';
import {I18nProvider} from '@/lib/i18n/client';
import {en} from '@/lib/i18n/dictionaries/en';
import {protectProjection} from '@/lib/use-protected-projection';
import {invalidateSurfaceCache} from '@/lib/surface-cache';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const mocks=vi.hoisted(()=>({list:vi.fn(),prepare:vi.fn(),apply:vi.fn(),confirm:vi.fn()}));
vi.mock('@/lib/workspace-context',()=>({useWorkspaceContext:()=>({workspaceId:'fictional-w',me:{id:'fictional-admin'}})}));
vi.mock('@/lib/surface-prefetch',()=>({workspaceKnowledgeBindingCacheKey:(w:string,u:string)=>`workspace-access:${w}:${u}:knowledge-bindings`}));
vi.mock('@/lib/api/workspace-access',()=>({fetchLegacyKnowledgeBindings:mocks.list,prepareLegacyKnowledgeBinding:mocks.prepare,applyLegacyKnowledgeBinding:mocks.apply,ORGANIZATION_CHANGED_EVENT:'brian:organization-changed'}));
vi.mock('@/components/ui/confirm-dialog',()=>({confirmDialog:mocks.confirm}));
vi.mock('@/components/chrome/surface-skeleton',()=>({SurfaceSkeletonFor:()=> <div data-skeleton/>}));
let root:Root,host:HTMLDivElement;
const t=en.accessMigration;
async function render(departmentId='fictional-team'){await act(async()=>root.render(<I18nProvider locale="en" dict={en}><LegacyKnowledgeBindings departmentId={departmentId} departmentName="Personal"/></I18nProvider>));}
async function click(text:string){const b=[...host.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent===text);expect(b).toBeDefined();await act(async()=>b!.click());}
beforeEach(()=>{
 vi.clearAllMocks();invalidateSurfaceCache('workspace-access:');host=document.createElement('div');document.body.append(host);root=createRoot(host);
 mocks.list.mockImplementation(async()=>protectProjection({validForMs:30000,policyRevision:'7',sources:[{id:'fictional-source',sourceType:'local',entryCount:'222'}]},performance.now()));
 mocks.prepare.mockResolvedValue({status:'prepared',reviewId:'fictional-review',payloadHash:'review-hash',expiresAt:new Date(Date.now()+600000).toISOString(),sourceId:'fictional-source',entryCount:'222',configuredByUserId:'fictional-admin',binding:{sensitivity:'internal',compartments:['team:fictional-team'],projectIds:[]}});
 mocks.apply.mockResolvedValue({reviewId:'fictional-review'});mocks.confirm.mockResolvedValue(true);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();invalidateSurfaceCache('workspace-access:');});
describe('[COMP:app-web/workspace-access] reviewed legacy knowledge binding',()=>{
 it('shows the scope, configuring account and preservation count before applying the exact review',async()=>{
  await render();await click(`${t.knowledgeBindingAction}: Personal`);
  expect(mocks.prepare).toHaveBeenCalledWith('fictional-w','fictional-source','fictional-team');
  const dialog=renderToStaticMarkup(<I18nProvider locale="en" dict={en}>{mocks.confirm.mock.calls[0][0].content}</I18nProvider>);
  for(const value of [t.knowledgeBindingReview,'Personal','fictional-admin','222','review-hash'])expect(dialog).toContain(value);
  expect(mocks.apply).toHaveBeenCalledWith('fictional-w','fictional-review','review-hash');
 });
 it('does not convert a source after cancellation or a missing department read edge',async()=>{
  mocks.confirm.mockResolvedValueOnce(false);await render();await click(`${t.knowledgeBindingAction}: Personal`);expect(mocks.apply).not.toHaveBeenCalled();
  mocks.prepare.mockRejectedValueOnce(new Error('knowledge_binding_department_access_required'));
  await click(`${t.knowledgeBindingAction}: Personal`);expect(host.textContent).toContain(t.knowledgeBindingAccess);expect(mocks.apply).not.toHaveBeenCalled();
 });
 it('cancels confirmation when the selected destination changes',async()=>{
  let resolve!:(approved:boolean)=>void;
  mocks.confirm.mockImplementationOnce(()=>new Promise(accept=>{resolve=accept}));
  await render();await click(`${t.knowledgeBindingAction}: Personal`);
  const signal=mocks.confirm.mock.calls[0][0].signal;
  await render('different-fictional-team');expect(signal.aborted).toBe(true);
  await act(async()=>resolve(true));expect(mocks.apply).not.toHaveBeenCalled();
 });
 it('retries a lost response with the same confirmed review',async()=>{
  mocks.apply.mockRejectedValueOnce(new Error('network'));
  await render();await click(`${t.knowledgeBindingAction}: Personal`);await click(en.workspaceAccess.retryChange);
  expect(mocks.prepare).toHaveBeenCalledTimes(1);expect(mocks.apply.mock.calls).toEqual([['fictional-w','fictional-review','review-hash'],['fictional-w','fictional-review','review-hash']]);
 });
});
