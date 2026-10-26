// @vitest-environment jsdom
import {act,type ButtonHTMLAttributes} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {en} from '@/lib/i18n/dictionaries/en';
const api=vi.hoisted(()=>({fetchApplicationConsent:vi.fn(),decideApplicationConsent:vi.fn()}));
vi.mock('@/lib/api/application-consent',()=>api);vi.mock('@/lib/i18n/client',()=>({useT:()=>en}));
vi.mock('next/navigation',()=>({useSearchParams:()=>new URLSearchParams({application:'11111111-1111-4111-8111-111111111111',req:'signed-request'})}));
vi.mock('@/components/ui/button',()=>({Button:({variant:_variant,...props}:ButtonHTMLAttributes<HTMLButtonElement>&{variant?:string})=><button {...props}/> }));
import {ApplicationConsent} from '../page';
const review={clientName:'Fictional portal',clientUri:null,scope:'read_write',workspaces:[{id:'22222222-2222-4222-8222-222222222222',name:'Fictional workspace'}],application:{id:'11111111-1111-4111-8111-111111111111',qualified:true,review:'signed-review',resources:[{typeKey:'record.fixture',selector:{kind:'ids',ids:['record-a']},actions:['read','patch'],readFields:['title'],writeFields:['state']}]}};
describe('[COMP:app-web/application-consent] OSS application consent page',()=>{
 let container:HTMLDivElement,root:Root;
 beforeEach(()=>{api.fetchApplicationConsent.mockReset();api.decideApplicationConsent.mockReset();vi.spyOn(document,'hidden','get').mockReturnValue(false);(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;container=document.createElement('div');document.body.append(container);root=createRoot(container);});
 afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.restoreAllMocks();});
 const mount=()=>act(async()=>{root.render(<ApplicationConsent/>);});
 const allow=()=>[...container.querySelectorAll('button')].find(button=>button.textContent==='Allow');
 it('renders exact current resource fields and sends the same signed review only on explicit Allow',async()=>{
  api.fetchApplicationConsent.mockResolvedValue(review);api.decideApplicationConsent.mockReturnValue(new Promise(()=>{}));await mount();
  expect(container.textContent).toContain('Fictional portal');expect(container.textContent).toContain('record-a');expect(container.textContent).toContain('Writable fields: state');
  await act(async()=>allow()!.click());expect(api.decideApplicationConsent).toHaveBeenCalledWith(review.application.id,'signed-request',review,'allow');expect(api.decideApplicationConsent).toHaveBeenCalledTimes(1);
 });
 it('clears the review while hidden and discards a superseded response',async()=>{
  let resolve:(value:typeof review)=>void=()=>{};api.fetchApplicationConsent.mockReturnValue(new Promise(done=>{resolve=done;}));await mount();
  vi.spyOn(document,'hidden','get').mockReturnValue(true);await act(async()=>{document.dispatchEvent(new Event('visibilitychange'));resolve(review);});expect(container.textContent).not.toContain('Fictional portal');expect(allow()).toBeUndefined();
 });
 it('holds access on a denied current review without exposing an Allow action',async()=>{
  api.fetchApplicationConsent.mockRejectedValue(Error('access_unavailable'));await mount();expect(container.querySelector('[role="alert"]')).not.toBeNull();expect(allow()).toBeUndefined();
 });
});
