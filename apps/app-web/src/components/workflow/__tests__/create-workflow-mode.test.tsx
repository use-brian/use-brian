// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {CreateWorkflowModal} from '../create-workflow-modal';
import {I18nProvider} from '@/lib/i18n/client';
import {en} from '@/lib/i18n/dictionaries/en';
const mocks=vi.hoisted(()=>({create:vi.fn(),push:vi.fn(),fail:vi.fn(),ready:true,snapshot:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:mocks.push})}));
vi.mock('@/contexts/workspace-context',()=>({useWorkspaces:()=>({activeId:'w'})}));
vi.mock('@/components/context/mode-aware-context',()=>({useCreationContext:()=>({ready:mocks.ready,snapshot:mocks.snapshot,fail:mocks.fail,isCurrent:()=>true,legacy:false}),ModeAwareCreationContext:()=> <p>{'Shared destination preview'}</p>}));
vi.mock('@/lib/api/studio',()=>({listAssistants:async()=>[]}));
vi.mock('@/lib/api/workflow',()=>({createWorkflow:mocks.create}));
vi.mock('@/lib/workflow-events',()=>({requestWorkflowRefresh:vi.fn()}));
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLDivElement,root:Root;
async function render(){await act(async()=>root.render(<I18nProvider locale="en" dict={en}><CreateWorkflowModal onClose={()=>{}}/></I18nProvider>));}
async function fill(selector:string,value:string){const el=host.querySelector<HTMLInputElement|HTMLTextAreaElement>(selector)!;await act(async()=>{Object.getOwnPropertyDescriptor(el.tagName==='INPUT'?HTMLInputElement.prototype:HTMLTextAreaElement.prototype,'value')!.set!.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));});}
async function submit(){await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));}
beforeEach(()=>{vi.clearAllMocks();mocks.ready=true;mocks.snapshot.mockReturnValue({contextGroupId:'default-team',contextProjectId:'project',expectedPolicyRevision:'7'});mocks.create.mockResolvedValue({ok:true,workflow:{id:'created'}});host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
describe('[COMP:app-web/mode-aware-context] manual workflow production creation',()=>{
 it('previews destination and sends admitted department, Project and revision',async()=>{await render();await fill('#cwm-name','Draft');await fill('#cwm-prompt','Prepare report');await submit();expect(host.textContent).toContain('Shared destination preview');expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({workspaceId:'w',contextGroupId:'default-team',contextProjectId:'project',expectedPolicyRevision:'7'}));expect(mocks.push).toHaveBeenCalledWith('/w/w/workflow/created');});
 it('blocks stale creation and preserves text rather than auto-resubmitting changed intent',async()=>{await render();await fill('#cwm-name','Draft');await fill('#cwm-prompt','Prepare report');mocks.create.mockResolvedValue({ok:false,error:'access_policy_conflict'});await submit();expect(mocks.fail).toHaveBeenCalled();expect((host.querySelector('#cwm-name') as HTMLInputElement).value).toBe('Draft');expect(mocks.push).not.toHaveBeenCalled();mocks.ready=false;mocks.snapshot.mockReturnValue(null);await render();await submit();expect(mocks.create).toHaveBeenCalledTimes(1);});
});
