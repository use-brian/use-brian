// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '@/lib/i18n/dictionaries/en';
import { ja } from '@/lib/i18n/dictionaries/ja';
import { zh } from '@/lib/i18n/dictionaries/zh';
import { zhCN } from '@/lib/i18n/dictionaries/zh-cn';
import { resetSurfaceCache, SurfaceCacheEvictionError, invalidateSurfaceCache } from '@/lib/surface-cache';
import { RoutineProposalReview, RoutineIntakeEditor, RoutineChatPickup } from '../routine-intake';
import type { RoutineProposal } from '@/lib/api/routine-intake';
import type { WorkflowFull } from '@/lib/api/workflow';
const api=vi.hoisted(()=>({get:vi.fn(),state:vi.fn(),list:vi.fn(),propose:vi.fn(),decide:vi.fn()}));
vi.mock('@/lib/api/routine-intake',()=>({getRoutineProposal:api.get,getRoutineIntake:api.state,listRoutineProposals:api.list,proposeRoutineIntake:api.propose,decideRoutineProposal:api.decide}));
vi.mock('@/lib/i18n/client',()=>({useT:()=>en}));
vi.mock('@/lib/surface-prefetch',()=>({routineIntakeCacheKey:(w:string,id:string)=>`routine-intake:${w}:viewer:${id}`}));
vi.mock('@/lib/use-workspace-directory',()=>({useWorkspaceMemberDirectory:()=>({data:{members:[]}})}));
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const c=en.routineIntake;
const configuration={contextGroupId:'department',contextProjectId:null,trigger:{kind:'event' as const,event:{sources:[{source:{type:'task' as const},match:{inChannels:['created']}}]}},
  definition:{startStepId:'step',steps:[],defaultExecutor:{kind:'assistant' as const,assistantId:'selected-assistant'},taskIntake:{version:1 as const,
    home:{kind:'department' as const,id:'department'},permittedActions:['saveTask'],requiredAccounts:[],blueprint:{outcome:'Prepare the fictional summary',description:'Review the source',completionCheck:'Summary saved',inputs:[]}}}};
let proposal:RoutineProposal,host:HTMLDivElement,root:Root;
beforeEach(()=>{
  vi.clearAllMocks();resetSurfaceCache();
  proposal={id:'proposal',workspaceId:'workspace',status:'pending',arguments:{workflowId:'workflow',expectedRevision:7,before:null,after:configuration,
    rationale:'Three observed reports repeat this work.',uncertainties:['Review the delivery target.'],sourceEvidence:{sources:[{resourceKind:'task',resourceId:'source-task'}]}}};
  api.get.mockImplementation(async()=>proposal);api.state.mockResolvedValue({revision:7,configured:true,enabled:true,configuration});
  api.list.mockResolvedValue({proposals:[]});api.propose.mockResolvedValue(proposal);api.decide.mockResolvedValue({revision:8,replayed:false});
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(()=>{act(()=>root.unmount());host.remove();resetSurfaceCache();});
const button=(text:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent===text) as HTMLButtonElement;
const render=async()=>{await act(async()=>root.render(<RoutineProposalReview workspaceId="workspace" proposalId="proposal"/>));};

describe('[COMP:app-web/routine-intake] exact review, inactive authoring and protected pickup',()=>{
  it.each([360,1280])('I11: shows exact before/after, selected executor, source support and allowance at %ipx without applying',async width=>{
    Object.defineProperty(window,'innerWidth',{value:width,configurable:true});await render();
    expect(host.textContent).toContain(c.before);expect(host.textContent).toContain(c.after);
    expect(host.textContent).toContain('selected-assistant');expect(host.textContent).toContain('source-task');
    expect(host.textContent).toContain(c.allowance);expect(host.querySelector('pre')?.textContent).toContain('inChannels');
    expect(api.decide).not.toHaveBeenCalled();expect(button(c.apply).className).toContain('min-h-11');
    expect(host.querySelector('select')).toBeNull();
  });
  it('I07/I11: applies only after an explicit click using the inspected revision and one idempotency key',async()=>{
    await render();await act(async()=>button(c.apply).click());
    expect(api.decide).toHaveBeenCalledExactlyOnceWith('proposal','apply',7,expect.any(String));
    expect(host.textContent).toContain(c.decided);
  });
  it('I08: rejection uses the same exact decision boundary',async()=>{
    await render();await act(async()=>button(c.reject).click());
    expect(api.decide).toHaveBeenCalledExactlyOnceWith('proposal','reject',7,expect.any(String));
  });
  it('I10: current source denial evicts private configuration and removes decisions',async()=>{
    await render();api.get.mockRejectedValue(new SurfaceCacheEvictionError(new Error('denied')));
    await act(async()=>invalidateSurfaceCache('routine-intake:workspace:viewer:proposal:proposal'));
    expect(host.textContent).not.toContain('Prepare the fictional summary');
    expect(host.textContent).not.toContain('source-task');expect(button(c.apply)).toBeUndefined();
  });
  it('I11: editor saves an inactive proposal using its saved baseline revision and explains disable',async()=>{
    const workflow={id:'workflow',workspaceId:'workspace',name:'Fictional routine',taskIntakeRevision:7,...configuration} as unknown as WorkflowFull;
    await act(async()=>root.render(<RoutineIntakeEditor workflow={workflow} draft={workflow} executorChoices={[]} onChange={()=>{}} onApplied={()=>{}}/>));
    expect(host.textContent).toContain(c.disableExplanation);expect(api.propose).not.toHaveBeenCalled();
    await act(async()=>button(c.propose).click());
    expect(api.propose).toHaveBeenCalledWith('workflow',configuration,7,c.editorRationale,expect.any(String));
    expect(api.decide).not.toHaveBeenCalled();
  });
  it('I10/I11: origin Chat pickup requests only the admitted session projection',async()=>{
    await act(async()=>root.render(<RoutineChatPickup workspaceId="workspace" sessionId="session"/>));
    expect(api.list).toHaveBeenCalledWith('workspace',undefined,'session');
    expect(api.decide).not.toHaveBeenCalled();
  });
  it('I11: all four dictionaries have the same complete copy and no banned dash',()=>{
    for (const dictionary of [en,ja,zh,zhCN]) {
      expect(Object.keys(dictionary.routineIntake).sort()).toEqual(Object.keys(c).sort());
      expect(Object.values(dictionary.routineIntake).every(v=>v.length>0 && !v.includes('—'))).toBe(true);
    }
  });
});
