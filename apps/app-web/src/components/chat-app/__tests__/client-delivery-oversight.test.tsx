// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { ClientDeliveryOversight } from '../client-delivery-oversight';
import { I18nProvider } from '@/lib/i18n/client';
import type { Dictionary } from '@/lib/i18n/dictionaries';
import { en } from '@/lib/i18n/dictionaries/en';
import { ja } from '@/lib/i18n/dictionaries/ja';
import { zh } from '@/lib/i18n/dictionaries/zh';
import { zhCN } from '@/lib/i18n/dictionaries/zh-cn';
import { resetSurfaceCache } from '@/lib/surface-cache';
import { CrmReferenceRequestError } from '@/lib/api/crm-references';
import type { DeliveryDetail } from '@/lib/api/crm-delivery-oversight';
const f=vi.hoisted(()=>({list:vi.fn(),detail:vi.fn(),command:vi.fn(),confirm:vi.fn(),viewer:'viewer'}));
vi.mock('@/lib/api/crm-delivery-oversight',()=>({fetchDeliveryCommitments:f.list,fetchDeliveryDetail:f.detail,executeDeliveryCommand:f.command}));
vi.mock('@/components/ui/confirm-dialog',()=>({confirmDialog:f.confirm}));
vi.mock('next/navigation',()=>({useRouter:()=>({prefetch:vi.fn()})}));
vi.mock('@/lib/user',()=>({getUserInfo:()=>({id:f.viewer})}));
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const id='11111111-1111-4111-8111-111111111111';
const source={kind:'session_message' as const,id,revision:'1',quote:'Agreed: deliver a fictional report.',start:0,end:34};
const commitment={id,outcome:'Fictional agreed report',dueDate:'2000-01-01',version:1,recognitionState:'recognised' as const,recognitionReason:'authenticated',source,
 sourceNavigation:{type:'conversation' as const,id,visibility:'workspace' as const},originChatId:id,taskIds:[],goalIds:[]};
const detail:DeliveryDetail={commitment,observations:[],linkedWork:[],evidenceCursor:null,assessment:{recognition:'recognised',coverage:'unobserved',outcome:'unknown',issue:null,nextAction:null,
 lastKnownAt:null,evaluatedAt:'2026-10-15T00:00:00Z',partial:false,reasonCodes:['no_observation']}};
function protect<T>(value:T){return {...value,validForMs:30_000,projectionDeadline:Date.now()+30_000,projectionMonotonicDeadline:performance.now()+30_000};}
let root:Root,host:HTMLDivElement;
const text=()=>host.textContent??'';
const button=(label:string)=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent===label||b.getAttribute('aria-label')===label)!;
async function click(label:string){const b=button(label);expect(b).toBeTruthy();await act(async()=>{b.click()})}
async function change(label:string,value:string){
 const node=Array.from(host.querySelectorAll('label')).find(l=>l.textContent?.includes(label))?.querySelector('input,textarea') as HTMLInputElement|HTMLTextAreaElement;
 const prototype=node instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
 await act(async()=>{Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}))});
}
async function view(onDraft=vi.fn(),scope:{kind:'personal'}|{kind:'project';id:string}={kind:'personal'},dict:Dictionary=en){
 await act(async()=>root.render(<I18nProvider locale="en" dict={dict}><ClientDeliveryOversight workspaceId="workspace" scope={scope} onDraft={onDraft} hideWhenEmpty={false}/></I18nProvider>));
}
beforeEach(()=>{vi.useFakeTimers();resetSurfaceCache();vi.clearAllMocks();f.viewer='viewer';host=document.createElement('div');document.body.append(host);root=createRoot(host);
 f.list.mockResolvedValue(protect({commitments:[commitment],nextCursor:null}));f.detail.mockResolvedValue(protect(detail));f.command.mockResolvedValue({record:{id,version:2},duplicate:false});f.confirm.mockResolvedValue(true)});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();resetSurfaceCache();vi.useRealTimers()});
async function open(){await click(`Inspect evidence: ${commitment.outcome}`);expect(host.querySelector('[data-testid="delivery-detail"]')).toBeTruthy()}
describe('[COMP:app-web/client-delivery-oversight] quiet scoped Chat pickup',()=>{
 it('CO03/CO11 elapsed date and unobserved work stay quiet; update is draft-only without a recipient',async()=>{
  const onDraft=vi.fn();await view(onDraft);await open();
  expect(text()).toContain(en.clientDelivery.coverage.unobserved);expect(text()).toContain(en.clientDelivery.outcomes.unknown);
  expect(host.querySelector('[role="alert"]')).toBeNull();expect(f.command).not.toHaveBeenCalled();expect(onDraft).not.toHaveBeenCalled();
  await click(en.clientDelivery.askUpdate);expect(onDraft).toHaveBeenCalledOnce();expect(onDraft.mock.calls[0][0]).toContain(id);expect(onDraft.mock.calls[0][0]).toContain('I will choose a recipient');expect(f.command).not.toHaveBeenCalled();
  expect(host.querySelector('a')?.getAttribute('href')).toContain('/chat?v=workspace&s=');
 })
 it('CO04/CO05 renders attributable report time and partial coverage without verified delivery',async()=>{
  f.detail.mockResolvedValue(protect({...detail,evidenceCursor:'opaque',assessment:{...detail.assessment,coverage:'reported',outcome:'reported_completion',lastKnownAt:'2026-10-14T00:00:00Z',partial:true},
   observations:[{id,source,kind:'human_report',claim:'completed',statement:'The report is completed.',reporterUserId:id,reporterName:'Fictional teammate',occurredAt:'2026-10-14T00:00:00Z',readAt:'2026-10-15T00:00:00Z',workId:null}]}));
  await view();await open();expect(text()).toContain(en.clientDelivery.outcomes.reported_completion);expect(text()).toContain('Reported by Fictional teammate');expect(text()).toContain(en.clientDelivery.partial);expect(text()).not.toContain(en.clientDelivery.outcomes.verified_delivery);
 })
 it('CO12 correction is versioned and never applied by autosaving text',async()=>{
  await view();await open();await click(en.clientDelivery.review);await change(en.clientDelivery.outcomeLabel,'Clarified existing report');await change(en.clientDelivery.reason,'Clarify existing evidence');
  expect(f.command).not.toHaveBeenCalled();await click(en.clientDelivery.correct);
  expect(f.command).toHaveBeenCalledOnce();expect(f.command.mock.calls[0]).toEqual(['workspace',expect.objectContaining({kind:'review_delivery_recognition',commitmentId:id,expectedVersion:1,decision:'correct',outcome:'Clarified existing report',reason:'Clarify existing evidence'})]);
 })
 it('CO09 uncertain human retry preserves the exact command identity and payload',async()=>{
  f.command.mockRejectedValueOnce(new CrmReferenceRequestError('network_error',null));await view();await open();await click(en.clientDelivery.review);await change(en.clientDelivery.reason,'Existing evidence');await click(en.clientDelivery.dismiss);
  expect(text()).toContain(en.clientDelivery.uncertain);await click(en.clientDelivery.retryReview);
  expect(f.command).toHaveBeenCalledTimes(2);expect(f.command.mock.calls[1]).toEqual(f.command.mock.calls[0]);expect(f.confirm).toHaveBeenCalledOnce();
 })
 it('CO08 scope navigation and viewer switches cannot retain protected detail',async()=>{
  await view();await open();f.list.mockResolvedValue(protect({commitments:[],nextCursor:null}));f.viewer='another-viewer';await view(vi.fn(),{kind:'project',id:'another-project'});
  expect(text()).toContain(en.clientDelivery.empty);expect(host.querySelector('[data-testid="delivery-detail"]')).toBeNull();
 })
 it('CO08 current-content expiry removes quotes and update controls while offline',async()=>{
  await view();await open();f.detail.mockRejectedValue(new Error('offline'));f.list.mockRejectedValue(new Error('offline'));
  await act(async()=>{await vi.advanceTimersByTimeAsync(31_000)});
  expect(text()).not.toContain(source.quote);expect(button(en.clientDelivery.askUpdate)).toBeUndefined();
 })
 it('CO12 refusal and empty remain distinct',async()=>{
  f.list.mockRejectedValue(new Error('refused'));await view();expect(host.querySelector('[role="alert"]')).toBeTruthy();expect(text()).not.toContain(en.clientDelivery.empty);
 })
 it.each([en,ja,zh,zhCN])('CO12 all locales expose translated copy and actions',async dict=>{
  await view(vi.fn(),{kind:'personal'},dict);expect(host.querySelector('section')?.getAttribute('aria-label')).toBe(dict.clientDelivery.title);expect(dict.clientDelivery.updateDraft).toContain('{id}');
 })
})
