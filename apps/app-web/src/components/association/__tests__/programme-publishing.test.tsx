// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const api=vi.hoisted(()=>({module:vi.fn(),read:vi.fn(),save:vi.fn(),publish:vi.fn(),confirm:vi.fn(),media:vi.fn(),url:vi.fn()}));
vi.mock('@/lib/api/association',async original=>({...await original<typeof import('@/lib/api/association')>(),getAssociationModuleSnapshot:api.module,getProgrammeCatalogueDraft:api.read,saveProgrammeCatalogueDraft:api.save,publishProgrammeCatalogue:api.publish,listWebsiteMedia:api.media,websiteMediaPreviewUrl:api.url}));
vi.mock('@/components/ui/confirm-dialog',()=>({confirmDialog:api.confirm}));
vi.mock('@/lib/surface-prefetch',()=>({associationModuleCacheKey:(w:string)=>`association-module:${w}:viewer`,associationPageCacheKey:(w:string,r:string)=>`crm:${w}:viewer:${r}`}));
import { ProgrammePublishingPanel } from '../programme-publishing';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
import { resetSurfaceCache } from '@/lib/surface-cache';
const c=en.associationPage.programmes;
const copy={name:'Synthetic programme',tagline:'Tagline',kicker:'Kicker',summary:'Summary',audienceBlurbs:{},sections:[{id:'about',heading:'About',paragraphs:['Text'],bullets:[],numbered:[],subsections:[]}],facts:[],steps:null,feeUnit:'',feeNotes:[],eligibility:[],contacts:[],links:[],cta:null};
const doc={schemaVersion:1 as const,audiences:{corporates:{gallery:'spacebiz-dialogues' as const,order:['synthetic']},schools:{gallery:'space-exchange-tour' as const,order:[]},students:{gallery:'young-marco-polo' as const,order:[]}},
  programmes:[{slug:'synthetic',audiences:['corporates' as const],order:0,sites:['oasa' as const],status:'live' as const,fee:null,gallery:null,cover:null,href:null,i18n:{en:copy}}]};
let host:HTMLDivElement,root:Root;
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
async function render(){await act(async()=>root.render(<I18nProvider locale="en" dict={en}><ProgrammePublishingPanel workspaceId="w"/></I18nProvider>));}
async function click(name:string){const button=[...host.querySelectorAll('button')].find(b=>b.textContent===name);expect(button).toBeDefined();await act(async()=>button!.click());}
beforeEach(()=>{resetSurfaceCache();vi.resetAllMocks();api.module.mockResolvedValue({canManage:true,module:{state:'enabled'}});api.read.mockResolvedValue({version:2,publishedRevision:1,document:doc,published:doc,observations:{},issues:[]});api.confirm.mockResolvedValue(true);api.save.mockResolvedValue({version:3});api.publish.mockResolvedValue({revision:2});api.media.mockResolvedValue([]);api.url.mockResolvedValue('https://x.test/i.jpg');host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();resetSurfaceCache();});
describe('[COMP:app-web/association] website programme publication',()=>{
 it('requires preview, publishes the exact saved version without a review dialog (it is reversible) and reports unread websites',async()=>{await render();expect(host.textContent).not.toContain(c.publish);await click(c.preview);await click(c.publish);expect(api.confirm).not.toHaveBeenCalled();expect(api.publish).toHaveBeenCalledWith('w',2);expect(host.textContent).toContain(en.associationPage.content.statusNotRead);});
 it('saves drafts without publishing, locks published slugs and prevents publishing unsaved changes',async()=>{await render();await click(c.edit);expect(host.textContent).not.toContain(c.publish);const slug=[...host.querySelectorAll('input')].find(input=>input.value==='synthetic');expect(slug?.disabled).toBe(true);await click(c.draft);expect(api.save).toHaveBeenCalledWith('w',2,doc);expect(api.publish).not.toHaveBeenCalled();});
 it('never offers to remove the English text and saves other languages untouched',async()=>{const translated={...doc,programmes:[{...doc.programmes[0],i18n:{en:copy,'zh-Hant':{...copy,name:'合成課程'}}}]};api.read.mockResolvedValue({version:2,publishedRevision:1,document:translated,published:translated,observations:{},issues:[]});await render();await click(c.edit);expect(host.textContent).not.toContain(c.removeTranslation);expect(host.textContent).not.toContain(c.noTranslation);await click(c.draft);const saved=api.save.mock.calls[0]![2] as typeof translated;expect(saved.programmes[0].i18n['zh-Hant']?.name).toBe('合成課程');});
 it('keeps an unsaved draft when discard confirmation is cancelled',async()=>{await render();await click(c.edit);api.confirm.mockResolvedValue(false);await click(en.associationPage.cancel);expect(host.textContent).toContain(c.draft);expect(api.save).not.toHaveBeenCalled();});
 it('does not fetch drafts for an ordinary member',async()=>{api.module.mockResolvedValue({canManage:false,module:{state:'enabled'}});await render();expect(api.read).not.toHaveBeenCalled();expect(host.textContent).not.toContain(c.edit);});
 it('shows the description field for a library cover instead of the path, and saves both values',async()=>{
  const MEDIA='22222222-2222-4222-8222-222222222222';
  const withCover={...doc,programmes:[{...doc.programmes[0],coverMediaId:MEDIA,i18n:{en:{...copy,coverAlt:'Students at a chapter meeting'}}}]};
  api.media.mockResolvedValue([{id:MEDIA,name:'chapters.jpg',mime:'image/jpeg',sizeBytes:1000,updatedAt:'2026-09-24T00:00:00Z'}]);
  api.read.mockResolvedValue({version:2,publishedRevision:1,document:withCover,published:withCover,observations:{},issues:[]});
  await render();await click(c.edit);
  const labels=[...host.querySelectorAll('label')].map(l=>l.textContent??'');
  expect(labels.some(l=>l.startsWith(c.coverAlt))).toBe(true);expect(labels.some(l=>l.startsWith(c.cover))).toBe(false);
  const alt=[...host.querySelectorAll('input')].find(i=>i.value==='Students at a chapter meeting');expect(alt).toBeDefined();
  await click(c.draft);const saved=api.save.mock.calls[0]![2] as typeof withCover;
  expect(saved.programmes[0].coverMediaId).toBe(MEDIA);expect(saved.programmes[0].i18n.en.coverAlt).toBe('Students at a chapter meeting');
 });
});
