// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const api=vi.hoisted(()=>({module:vi.fn(),read:vi.fn(),save:vi.fn(),publish:vi.fn(),media:vi.fn(),url:vi.fn(),confirm:vi.fn()}));
vi.mock('@/lib/api/association',async original=>({...await original<typeof import('@/lib/api/association')>(),getAssociationModuleSnapshot:api.module,getSiteContentDraft:api.read,saveSiteContentDraft:api.save,publishSiteContent:api.publish,listWebsiteMedia:api.media,websiteMediaPreviewUrl:api.url}));
vi.mock('@/components/ui/confirm-dialog',()=>({confirmDialog:api.confirm}));
vi.mock('@/lib/surface-prefetch',()=>({associationModuleCacheKey:(w:string)=>`association-module:${w}:viewer`,associationPageCacheKey:(w:string,r:string)=>`crm:${w}:viewer:${r}`}));
import { SiteContentPanel } from '../site-content/site-content-panel';
import { FieldsEditor } from '../site-content/document-editor';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
import { format } from '@/lib/i18n/format';
import { resetSurfaceCache } from '@/lib/surface-cache';
const c=en.associationPage.content;
const doc={schemaVersion:1,partners:[{id:'acme',name:'Acme',logo:{src:'/media/partners/acme.png',alt:{en:'Acme logo'}},sites:['oasa'],active:true,order:0}]};
let host:HTMLDivElement,root:Root;
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
async function render(collection:'partners'|'people'='partners'){await act(async()=>root.render(<I18nProvider locale="en" dict={en}><SiteContentPanel workspaceId="w" collection={collection}/></I18nProvider>));}
const buttons=(name:string)=>[...host.querySelectorAll('button')].filter(b=>b.textContent===name);
async function click(name:string){const b=buttons(name)[0];expect(b,name).toBeDefined();await act(async()=>b!.click());}
async function type(input:HTMLInputElement|HTMLTextAreaElement,value:string){const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input),'value')!.set!;await act(async()=>{setter.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});}
beforeEach(()=>{resetSurfaceCache();vi.resetAllMocks();api.module.mockResolvedValue({canManage:true,module:{state:'enabled'}});
 api.read.mockResolvedValue({collection:'partners',version:2,publishedRevision:1,document:doc,published:doc,observations:{oasa:{revision:1,observedAt:'2026-09-24T00:00:00Z'}},readers:['oasa','sea'],issues:[]});
 api.media.mockResolvedValue([]);api.confirm.mockResolvedValue(true);api.save.mockResolvedValue({version:3});api.publish.mockResolvedValue({revision:2});
 host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();resetSurfaceCache();});
describe('[COMP:app-web/site-content] website content publication',()=>{
 it('publishes the saved version without a review dialog and shows each website by name',async()=>{
  await render();expect(host.textContent).toContain(format(c.observed,{site:'OASA'}));expect(host.textContent).toContain(format(c.pending,{site:'SEA'}));
  await click(c.publish);expect(api.confirm).not.toHaveBeenCalled();expect(api.publish).toHaveBeenCalledWith('w','partners',2);
  expect(host.textContent).toContain(c.publishDone);
 });
 it('edits a list entry and saves the whole document without publishing',async()=>{
  await render();await click(c.edit);
  const name=[...host.querySelectorAll('input')].find(i=>i.value==='Acme')!;await type(name,'Acme Space');
  await click(c.save);expect(api.save).toHaveBeenCalledTimes(1);
  const [,collection,version,saved]=api.save.mock.calls[0]!;expect(collection).toBe('partners');expect(version).toBe(2);
  expect(saved.partners[0].name).toBe('Acme Space');expect(saved.partners[0].logo.src).toBe('/media/partners/acme.png');expect(api.publish).not.toHaveBeenCalled();
 });
 it('keeps English as the fallback: a typed translation is stored, clearing it drops the key',async()=>{
  const changes:unknown[]=[];let value:Record<string,unknown>={title:{en:'Council'}};
  const field=[{kind:'localized' as const,key:'title',label:'title'}];
  const draw=async()=>act(async()=>root.render(<I18nProvider locale="en" dict={en}><FieldsEditor fields={field} value={value} context={{locale:'zh-Hant',media:[],workspaceId:'w',sites:['north','south'],siteNames:{}}} onChange={next=>{changes.push(next);value=next;}}/></I18nProvider>));
  await draw();const input=host.querySelector('input')!;expect(input.placeholder).toBe('Council');expect(host.textContent).toContain(c.englishShown);
  await type(input,'理事會（2025–2027）');expect(value).toEqual({title:{en:'Council','zh-Hant':'理事會（2025–2027）'}});
  await draw();await type(host.querySelector('input')!,'');expect(value).toEqual({title:{en:'Council'}});
 });
 it('adds an entry from the descriptor blank and blocks publishing when the server reports issues',async()=>{
  api.read.mockResolvedValue({collection:'partners',version:3,publishedRevision:1,document:doc,published:doc,observations:{},readers:['oasa','sea'],issues:['Partner acme is listed twice']});
  await render();expect(host.textContent).toContain('Partner acme is listed twice');expect(host.textContent).toContain(c.issuesTitle);
  expect(buttons(c.publish)).toHaveLength(0);
  await click(c.edit);await click(`${c.add}: ${c.fields.partners}`);await click(c.save);
  expect(api.save.mock.calls[0]![3].partners).toHaveLength(2);expect(api.save.mock.calls[0]![3].partners[1]).toMatchObject({sites:['oasa'],active:true});
 });
 it('does not read drafts for an ordinary member',async()=>{api.module.mockResolvedValue({canManage:false,module:{state:'enabled'}});await render();expect(api.read).not.toHaveBeenCalled();expect(buttons(c.edit)).toHaveLength(0);});
});
