"use client";

/** Exact review and inactive authoring inside native Workflow/Chat surfaces.
 * [COMP:app-web/routine-intake]
 */
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Skeleton } from '@/components/skeleton';
import { useWorkspaceMemberDirectory } from '@/lib/use-workspace-directory';
import { useT } from '@/lib/i18n/client';
import { useLeasedResource } from '@/lib/offline/surface-content-cache';
import { invalidateSurfaceCache } from '@/lib/surface-cache';
import { routineIntakeCacheKey } from '@/lib/surface-prefetch';
import { requestWorkflowRefresh } from '@/lib/workflow-events';
import { requestApprovalsRefresh } from '@/lib/approvals-events';
import { getRoutineIntake, getRoutineProposal, listRoutineProposals, proposeRoutineIntake, decideRoutineProposal, type RoutineConfiguration } from '@/lib/api/routine-intake';
import type { WorkflowFull, WorkflowDefinition } from '@/lib/api/workflow';

function Snapshot({value}:{value:RoutineConfiguration|null}) {
  const c=useT().routineIntake;
  if (!value) return <p>{c.newRoutine}</p>;
  const config=value.definition.taskIntake;
  const executor=value.definition.defaultExecutor;
  return <div className="min-w-0 space-y-2">
    <dl className="grid grid-cols-1 gap-1 text-sm">
      <dt className="font-medium">{c.outcome}</dt><dd className="break-words">{config?.blueprint.outcome ?? c.unresolved}</dd>
      <dt className="font-medium">{c.completion}</dt><dd className="break-words">{config?.blueprint.completionCheck ?? c.unresolved}</dd>
      <dt className="font-medium">{c.executor}</dt><dd className="break-all">{executor ? executor.kind==='person'?executor.memberId:executor.assistantId : c.unresolved}</dd>
      <dt className="font-medium">{c.home}</dt><dd className="break-all">{config?.home?.id ?? c.unresolved}</dd>
      <dt className="font-medium">{c.actions}</dt><dd className="break-words">{config?.permittedActions.join(', ') || c.none}</dd>
      <dt className="font-medium">{c.accounts}</dt><dd className="break-words">{config?.requiredAccounts.join(', ') || c.none}</dd>
    </dl>
    <details><summary className="min-h-8 max-sm:min-h-11 cursor-pointer py-2 text-sm">{c.exactConfiguration}</summary>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded border p-3 text-xs">{JSON.stringify(value,null,2)}</pre>
    </details>
  </div>;
}

export function RoutineProposalReview({workspaceId,proposalId,onResolved}:{workspaceId:string;proposalId:string;onResolved?:()=>void}) {
  const c=useT().routineIntake;
  const key=routineIntakeCacheKey(workspaceId,`proposal:${proposalId}`);
  const resource=useLeasedResource(key,()=>getRoutineProposal(proposalId));
  const proposal=resource.data;
  const [busy,setBusy]=useState(false),[failed,setFailed]=useState(false),[resolved,setResolved]=useState(false);
  const keys=useRef<Partial<Record<'apply'|'reject',string>>>({});
  if (resource.error || failed) return <div role="alert"><p>{c.unavailable}</p><Button className="max-sm:min-h-11" onClick={()=>{setFailed(false);void resource.refresh();}}>{c.retry}</Button></div>;
  if (!proposal) return <Skeleton className="h-36 w-full" />;
  const decide=async(decision:'apply'|'reject')=>{
    if (busy || resource.revalidating || resolved) return;
    setBusy(true);
    try {
      const token=keys.current[decision] ??= crypto.randomUUID();
      await decideRoutineProposal(proposal.id,decision,proposal.arguments.expectedRevision,token);
      setResolved(true);invalidateSurfaceCache(key);
      requestApprovalsRefresh(workspaceId);requestWorkflowRefresh(workspaceId);onResolved?.();
    } catch {setFailed(true);invalidateSurfaceCache(key);} finally {setBusy(false);}
  };
  return <section className="min-w-0 space-y-3 rounded border p-3" aria-label={c.review}>
    <h3 className="font-medium">{c.review}</h3><p className="text-sm">{c.inactive}</p>
    <p className="break-words text-sm">{proposal.arguments.rationale}</p>
    <div className="grid min-w-0 gap-4 md:grid-cols-2">
      <div><h4 className="mb-2 font-medium">{c.before}</h4><Snapshot value={proposal.arguments.before}/></div>
      <div><h4 className="mb-2 font-medium">{c.after}</h4><Snapshot value={proposal.arguments.after}/></div>
    </div>
    <div className="text-sm"><h4 className="font-medium">{c.support}</h4><ul className="space-y-1">{proposal.arguments.sourceEvidence.sources?.map(s=><li className="break-all" key={`${s.resourceKind}:${s.resourceId}`}>{s.resourceKind}: {s.resourceId}</li>)}</ul></div>
    {proposal.arguments.uncertainties.length>0 && <div className="text-sm"><h4 className="font-medium">{c.uncertainties}</h4><ul className="list-inside list-disc">{proposal.arguments.uncertainties.map((u,i)=><li className="break-words" key={i}>{u}</li>)}</ul></div>}
    <p className="text-sm text-muted-foreground">{c.allowance}</p>
    {proposal.status==='pending' && !resolved ? <div className="flex flex-wrap gap-2">
      <Button className="max-sm:min-h-11" disabled={busy || resource.revalidating} onClick={()=>void decide('apply')}>{c.apply}</Button>
      <Button className="max-sm:min-h-11" variant="outline" disabled={busy || resource.revalidating} onClick={()=>void decide('reject')}>{c.reject}</Button>
    </div> : <p role="status">{c.decided}</p>}
  </section>;
}

type ExecutorChoice={value:string;label:string};
export function RoutineChatPickup({workspaceId,sessionId}:{workspaceId:string;sessionId:string}) {
  const key=routineIntakeCacheKey(workspaceId,`session:${sessionId}`);
  const resource=useLeasedResource(key,()=>listRoutineProposals(workspaceId,undefined,sessionId));
  if (resource.error || !resource.data) return null;
  return <div className="min-w-0 space-y-3">{resource.data.proposals.map(p=><RoutineProposalReview key={p.id}
    workspaceId={workspaceId} proposalId={p.id} onResolved={()=>invalidateSurfaceCache(key)}/>)}</div>;
}

export function RoutineIntakeEditor({workflow,draft,executorChoices,onChange,onApplied}:{workflow:WorkflowFull;draft:WorkflowFull;
  executorChoices:ExecutorChoice[];onChange:(definition:WorkflowDefinition)=>void;onApplied:()=>void}) {
  const c=useT().routineIntake;
  const key=routineIntakeCacheKey(workflow.workspaceId,workflow.id);
  const resource=useLeasedResource(key,async()=>({state:await getRoutineIntake(workflow.id),...await listRoutineProposals(workflow.workspaceId,workflow.id)}));
  const [busy,setBusy]=useState(false),[failed,setFailed]=useState(false);
  const [localProposal,setLocalProposal]=useState<string|null>(null);
  const submission=useRef<{payload:string;key:string}|null>(null);
  const directory=useWorkspaceMemberDirectory(workflow.workspaceId);
  const choices=[...executorChoices,...(directory.data?.members.map(m=>({value:`person:${m.memberId}`,label:m.name || m.email || m.memberId})) ?? [])];
  const config=draft.definition.taskIntake;
  const executor=draft.definition.defaultExecutor;
  const change=(next:NonNullable<WorkflowDefinition['taskIntake']>)=>onChange({...draft.definition,taskIntake:next});
  const add=()=>change({version:1,home:draft.contextProjectId?{kind:'project',id:draft.contextProjectId}:draft.contextGroupId?{kind:'department',id:draft.contextGroupId}:undefined,
    blueprint:{outcome:'',description:'',completionCheck:'',inputs:[]},permittedActions:[],requiredAccounts:[]});
  const field=(label:string,value:string,onValue:(value:string)=>void)=><label className="block space-y-1 text-sm"><span>{label}</span><input className="min-h-8 max-sm:min-h-11 w-full rounded border bg-background px-3 text-base" value={value} onChange={e=>onValue(e.target.value)}/></label>;
  const save=async()=>{
    if (!resource.data || busy || resource.revalidating) return;
    const configuration:RoutineConfiguration={definition:draft.definition,trigger:draft.trigger,contextGroupId:draft.contextGroupId ?? null,contextProjectId:draft.contextProjectId ?? null};
    const payload=JSON.stringify(configuration);
    if (submission.current?.payload!==payload) submission.current={payload,key:crypto.randomUUID()};
    setBusy(true);setFailed(false);
    try {const proposal=await proposeRoutineIntake(workflow.id,configuration,workflow.taskIntakeRevision ?? 0,c.editorRationale,submission.current!.key);
      setLocalProposal(proposal.id);invalidateSurfaceCache(key);requestApprovalsRefresh(workflow.workspaceId);
    } catch {setFailed(true);} finally {setBusy(false);}
  };
  return <section className="min-w-0 space-y-3 rounded border p-4" aria-label={c.title}>
    <h2 className="font-medium">{c.title}</h2><p className="text-sm text-muted-foreground">{c.disableExplanation}</p>
    {!config ? <Button className="max-sm:min-h-11" variant="outline" onClick={add}>{c.draft}</Button> : <>
      <p className="text-sm">{c.inactive}</p>
      {field(c.outcome,config.blueprint.outcome,value=>change({...config,blueprint:{...config.blueprint,outcome:value}}))}
      {field(c.description,config.blueprint.description ?? '',value=>change({...config,blueprint:{...config.blueprint,description:value}}))}
      {field(c.completion,config.blueprint.completionCheck,value=>change({...config,blueprint:{...config.blueprint,completionCheck:value}}))}
      <label className="block space-y-1 text-sm"><span>{c.executor}</span><SearchableSelect aria-label={c.executor} value={executor?executor.kind==='assistant'?`assistant:${executor.assistantId}`:`person:${executor.memberId}`:''}
        items={choices} placeholder={c.chooseExecutor} searchPlaceholder={c.search} emptyMessage={c.unresolved} onValueChange={value=>{
          const [kind,id]=value.split(':');if (kind==='assistant') onChange({...draft.definition,defaultExecutor:{kind,assistantId:id}});
          if (kind==='person') onChange({...draft.definition,defaultExecutor:{kind,memberId:id}});
        }}/></label>
      <p className="break-all text-sm">{c.home}: {config.home?.id ?? c.unresolved}</p>
      {field(c.actions,config.permittedActions.join(', '),value=>change({...config,permittedActions:value.split(',').map(v=>v.trim()).filter(Boolean)}))}
      {field(c.accounts,config.requiredAccounts.join(', '),value=>change({...config,requiredAccounts:value.split(',').map(v=>v.trim()).filter(Boolean)}))}
      {config.blueprint.inputs.map((input,index)=><div className="grid gap-2 md:grid-cols-3" key={index}>
        {field(c.inputName,input.key,value=>change({...config,blueprint:{...config.blueprint,inputs:config.blueprint.inputs.map((old,i)=>i===index?{...old,key:value,label:value}:old)}}))}
        {field(c.inputPath,input.path,value=>change({...config,blueprint:{...config.blueprint,inputs:config.blueprint.inputs.map((old,i)=>i===index?{...old,path:value}:old)}}))}
        <Button className="max-sm:min-h-11 self-end" variant="outline" onClick={()=>change({...config,blueprint:{...config.blueprint,inputs:config.blueprint.inputs.filter((_,i)=>i!==index)}})}>{c.removeInput}</Button>
      </div>)}
      <Button className="max-sm:min-h-11" variant="outline" onClick={()=>change({...config,blueprint:{...config.blueprint,inputs:[...config.blueprint.inputs,{key:`input${config.blueprint.inputs.length+1}`,label:'',path:'event.',required:true}]}})}>{c.addInput}</Button>
      <p className="text-sm text-muted-foreground">{c.allowance}</p>
      <Button className="max-sm:min-h-11" disabled={busy || !resource.data || !!resource.error || resource.revalidating} onClick={()=>void save()}>{c.propose}</Button>
    </>}
    {(failed || !!resource.error) && <p role="alert">{c.unavailable}</p>}
    {[...new Set([...(resource.data?.proposals.map(p=>p.id) ?? []),...(localProposal?[localProposal]:[])])].map(id=><RoutineProposalReview key={id} workspaceId={workflow.workspaceId} proposalId={id} onResolved={()=>{setLocalProposal(null);invalidateSurfaceCache(key);onApplied();}}/>)}
  </section>;
}
