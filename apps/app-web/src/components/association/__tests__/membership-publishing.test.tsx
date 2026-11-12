// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const api=vi.hoisted(()=>({module:vi.fn(),read:vi.fn(),save:vi.fn(),publish:vi.fn(),list:vi.fn(),confirm:vi.fn()}));
vi.mock('@/lib/api/association',async original=>({...await original<typeof import('@/lib/api/association')>(),getAssociationModuleSnapshot:api.module,getMembershipCatalogueDraft:api.read,saveMembershipCatalogueDraft:api.save,publishMembershipCatalogue:api.publish,listAssociationPage:api.list}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn()})}));
vi.mock('@/components/ui/confirm-dialog',()=>({confirmDialog:api.confirm}));
vi.mock('@/lib/surface-prefetch',()=>({associationModuleCacheKey:(w:string)=>`association-module:${w}:viewer`,associationPageCacheKey:(w:string,r:string)=>`crm:${w}:viewer:${r}`}));
import { MembershipPublishingPanel } from '../membership-publishing';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
import { resetSurfaceCache } from '@/lib/surface-cache';
const c=en.associationPage.publishing;
const page={title:'Membership',intro:'Introduction',groups:[{id:'plans',title:'Plans',intro:''}],sections:[]};
const doc={schemaVersion:1,plans:[],pages:{oasa:{en:page,'zh-Hant':page,'zh-Hans':page},sea:{en:page,'zh-Hant':page,'zh-Hans':page}}};
let host:HTMLDivElement,root:Root;
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
async function render(initialPlan?: string){await act(async()=>root.render(<I18nProvider locale="en" dict={en}><MembershipPublishingPanel workspaceId="w" initialPlan={initialPlan}/></I18nProvider>));}
async function click(name:string){const button=[...host.querySelectorAll('button')].find(b=>b.textContent===name);expect(button).toBeDefined();await act(async()=>button!.click());}
beforeEach(()=>{resetSurfaceCache();vi.resetAllMocks();api.module.mockResolvedValue({canManage:true,module:{state:'enabled'}});api.list.mockResolvedValue({items:[],nextCursor:null});api.read.mockResolvedValue({version:2,publishedRevision:1,document:doc,published:doc,observations:{},issues:[]});api.confirm.mockResolvedValue(true);api.save.mockImplementation(async (_w, _version, document) => {api.read.mockResolvedValue({version:3,publishedRevision:1,document,published:doc,observations:{},issues:[]});return {version:3,issues:[]};});api.publish.mockResolvedValue({revision:2});host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();resetSurfaceCache();});
describe('[COMP:app-web/association] website publication',()=>{
 it('requires preview and confirmation, publishes the exact saved version and reports pending readers',async()=>{await render();expect(host.textContent).not.toContain(c.publish);await click(c.preview);api.confirm.mockResolvedValueOnce(false);await click(c.publish);expect(api.publish).not.toHaveBeenCalled();await click(c.publish);expect(api.publish).toHaveBeenCalledWith('w',2);expect(host.textContent).toContain(en.associationPage.content.statusNotRead);});
 it('prevents publishing unsaved changes and keeps the same preview after saving',async()=>{
   await render();await click(c.edit);await click(en.associationPage.manage.newPlan);await click(c.preview);
   await click(c.publish);expect(api.publish).not.toHaveBeenCalled();
   await click(c.draft);expect(api.save).toHaveBeenCalledWith('w',2,expect.objectContaining({plans:[expect.objectContaining({key:'plan-1'})]}));
   expect(host.textContent).toContain(en.associationPage.staff.backToEditor);
   expect(api.publish).not.toHaveBeenCalled();
   await click(c.publish);expect(api.publish).toHaveBeenCalledWith('w',3);
 });
 it('keeps an unsaved draft when discard confirmation is cancelled',async()=>{await render();await click(c.edit);await click(en.associationPage.manage.newPlan);api.confirm.mockResolvedValue(false);await click(en.associationPage.cancel);expect(host.textContent).toContain(c.draft);expect(api.save).not.toHaveBeenCalled();});
 it('opens the linked plan, previews its configured form, and saves its optional fields with the plan draft',async()=>{
   const plan = { key:'sample', feeMinor:0, currency:'HKD', billingPeriod:'one_time', availability:'public',
     application:{type:'application',proposerRequired:false,codeOfConduct:true,optionalFields:[]},
     i18n:Object.fromEntries(['en','zh-Hant','zh-Hans'].map(locale=>[locale,{name:'Sample plan',benefits:[],documents:[]}])), sites:['sea'], group:'plans', overrides:{} };
   api.read.mockResolvedValue({version:2,publishedRevision:1,document:{...doc,plans:[plan]},published:doc,observations:{},issues:[]});
   await render('sample');
   const s=en.associationPage.staff;
   await click(s.applicationForm);
   const toggle=Array.from(host.querySelectorAll<HTMLLabelElement>('label')).find(label=>label.textContent===s.specialRequest)?.querySelector<HTMLElement>('[role="switch"]');
   expect(toggle).toBeDefined();
   await act(async()=>toggle!.click());
   await click(s.previewForm);
   const preview=host.querySelector('[data-membership-form-preview]');
   expect(preview?.textContent).toContain(s.specialRequest);
   expect(preview?.textContent).not.toContain(s.proposerEmail);
   expect(api.save).not.toHaveBeenCalled();
   await click(c.draft);
   expect(api.save).toHaveBeenCalledWith('w',2,expect.objectContaining({plans:[expect.objectContaining({application:expect.objectContaining({optionalFields:['special_request']})})]}));
   expect(api.publish).not.toHaveBeenCalled();
   expect(host.querySelector('[data-membership-form-editor] [data-membership-form-preview]')?.textContent).toContain(s.specialRequest);
 });
 it('handles an observed site that is missing from an older publication',async()=>{
   api.read.mockResolvedValue({version:2,publishedRevision:1,document:doc,published:{...doc,pages:{oasa:doc.pages.oasa}},observations:{sea:{revision:1}},issues:[]});
   await render();await click(c.preview);
   expect(host.textContent).toContain(en.associationPage.staff.noPlanPreview);
 });
 it('does not fetch drafts for an ordinary member',async()=>{api.module.mockResolvedValue({canManage:false,module:{state:'enabled'}});await render();expect(api.read).not.toHaveBeenCalled();expect(host.textContent).not.toContain(c.edit);});
});
