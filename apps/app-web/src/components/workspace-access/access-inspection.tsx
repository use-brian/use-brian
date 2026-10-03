"use client";

/** Protected current-authority projections. [COMP:app-web/workspace-access] */
import {useState} from 'react';
import type {WorkspaceAccessOverview,WorkspaceAccessExplanationQuery} from '@use-brian/shared';
import {useWorkspaceContext} from '@/lib/workspace-context';
import {useT} from '@/lib/i18n/client';
import {useCachedResource,SurfaceCacheEvictionError} from '@/lib/surface-cache';
import {useProtectedProjection} from '@/lib/use-protected-projection';
import {workspaceAccessCacheKey,workspaceAccessInspectionCacheKey} from '@/lib/surface-prefetch';
import {fetchWorkspaceAccess,fetchWorkspaceAccessExplanation,fetchWorkspaceAccessEvents} from '@/lib/api/workspace-access';
import {Button} from '@/components/ui/button';
import {SearchableSelect} from '@/components/ui/searchable-select';
import {SurfaceSkeletonFor} from '@/components/chrome/surface-skeleton';

type Props={data:WorkspaceAccessOverview;close:()=>void};
export function AccessExplanationPanel(props:Props&{memberId:string;assistantId?:string}){
  const {workspaceId,me}=useWorkspaceContext();
  return <AccessExplanationContent key={`${workspaceId}:${me.id}:${props.memberId}:${props.assistantId??''}`} {...props}/>;
}
function AccessExplanationContent({data,memberId,assistantId,close}:Props&{memberId:string;assistantId?:string}){
  const {workspaceId,me}=useWorkspaceContext(),t=useT().workspaceAccess;
  const [selection,setSelection]=useState<WorkspaceAccessExplanationQuery>({memberId,assistantId});
  const query={...selection,expectedPolicyRevision:data.policyRevision};
  const key=workspaceAccessInspectionCacheKey(workspaceId,me.id,'explain',data.policyRevision,JSON.stringify(query));
  const resource=useCachedResource(key,()=>fetchWorkspaceAccessExplanation(workspaceId,query));
  const explanation=useProtectedProjection(key,resource.data,()=>{},resource.refresh);
  function pick(field:keyof WorkspaceAccessExplanationQuery,label:string,value:string,items:Array<{value:string;label:string}>){
    return <label className="grid gap-1 text-sm"><span>{label}</span><SearchableSelect aria-label={label} className="max-sm:min-h-11" value={value} items={items} onValueChange={next=>setSelection(old=>({...old,[field]:next==='none'?undefined:next}))}/></label>;
  }
  const reach=(ids:string[]|null)=>ids===null?t.allDepartments:[t.generalOnly,...data.teams.filter(team=>ids.includes(team.id)).map(team=>team.name)].join(', ');
  const pathLabels={trusted_role:t.pathTrusted,legacy:t.pathLegacy,membership:t.pathMembership,read_grant:t.pathGrant,team_read_grant:t.pathTeamGrant};
  return <section className="min-w-0 space-y-4 rounded-xl border border-border p-4" aria-label={t.explainAccess}>
    <header className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">{t.explainAccess}</h2><Button variant="ghost" className="max-sm:min-h-11" onClick={close}>{t.close}</Button></header>
    <Button variant="outline" className="max-sm:min-h-11" onClick={()=>setSelection({memberId})}>{t.resetExample}</Button>
    {!explanation?resource.error?<><p role="alert">{t.loadError}</p><Button className="max-sm:min-h-11" onClick={()=>void resource.refresh()}>{t.reload}</Button></>:<SurfaceSkeletonFor surface="organization" chrome={false}/>:<>
      <div className="grid gap-3 sm:grid-cols-2">
        {pick('assistantId',t.assistantCeiling,selection.assistantId??'none',[{value:'none',label:t.humanOnly},...explanation.choices.assistants.map(row=>({value:row.id,label:row.name||t.unnamed}))])}
        {pick('contextTeamId',t.contextDepartment,selection.contextTeamId??'none',[{value:'none',label:t.allDepartments},...data.teams.map(row=>({value:row.id,label:row.name}))])}
        {pick('contextProjectId',t.contextProject,selection.contextProjectId??'none',[{value:'none',label:t.reviewNone},...explanation.choices.projects.map(row=>({value:row.id,label:row.name}))])}
        {pick('targetTeamId',t.exampleDepartment,selection.targetTeamId??'none',[{value:'none',label:t.generalOnly},...data.teams.map(row=>({value:row.id,label:row.name}))])}
        {pick('action',t.exampleAction,selection.action??'read',[{value:'read',label:t.readAction},{value:'edit',label:t.editAction}])}
        {pick('sensitivity',t.clearance,selection.sensitivity??'internal',(['public','internal','confidential'] as const).map(value=>({value,label:t[value]})))}
      </div>
      <p className="text-sm">{t.clearance}: {t[explanation.clearance]}</p>
      <p className="text-sm">{t.readReach}: {reach(explanation.readTeamIds)}</p>
      <p className="text-sm">{t.editReach}: {reach(explanation.mutationTeamIds)}</p>
      <h3 className="font-medium">{t.managementEligibility}</h3><p className="text-sm text-muted-foreground">{t.managementHint}</p>
      {explanation.management.some(row=>row.canManageMembers||row.canApprove)?<ul className="space-y-2">{explanation.management.filter(row=>row.canManageMembers||row.canApprove).map(row=><li key={row.teamId} className="text-sm"><span>{data.teams.find(team=>team.id===row.teamId)?.name??t.unlistedScope}</span>: {[row.canManageMembers?t.manageMembers:null,row.canApprove?t.approveRequests:null].filter(Boolean).join(', ')}</li>)}</ul>:<p className="text-sm">{t.noManagement}</p>}
      <p role="status" className="rounded-lg bg-muted p-3 text-sm">{explanation.example.matchesScope?t.scopeMatches:t.scopeDenied}</p>
      <p className="text-sm text-muted-foreground">{t.currentPreviewHint}</p>
      <p className="text-sm text-muted-foreground">{t.resourceCheckRequired}</p>
      <h3 className="font-medium">{t.accessPaths}</h3><p className="text-sm text-muted-foreground">{t.scopePathHint}</p>
      {!explanation.paths.length?<p className="text-sm">{t.noAccessPaths}</p>:<ul className="divide-y divide-border">{explanation.paths.map((path,index)=><li key={`${path.kind}:${path.grantId??path.sourceTeamId??index}`} className="py-3 text-sm">
        <p>{pathLabels[path.kind]}{path.sourceTeamId?`: ${data.teams.find(team=>team.id===path.sourceTeamId)?.name??t.unlistedScope}`:''}</p>
        <p>{reach(path.targetTeamIds)}</p>{path.expiresAt?<p>{t.expires}: <time dateTime={path.expiresAt}>{new Date(path.expiresAt).toLocaleString()}</time></p>:null}
      </li>)}</ul>}
    </>}
  </section>;
}

export function AccessEventsPanel(props:Props){
  const {workspaceId,me}=useWorkspaceContext();
  return <AccessEventsContent key={`${workspaceId}:${me.id}:${props.data.policyRevision}`} {...props}/>;
}
function AccessEventsContent({data,close}:Props){
  const {workspaceId,me}=useWorkspaceContext(),t=useT().workspaceAccess;
  const [after,setAfter]=useState<string|undefined>();
  const key=workspaceAccessInspectionCacheKey(workspaceId,me.id,'events',data.policyRevision,after??'');
  const resource=useCachedResource(key,async()=>{
    const page=await fetchWorkspaceAccessEvents(workspaceId,after,after?data.policyRevision:undefined);
    if(page.policyRevision!==data.policyRevision)throw new SurfaceCacheEvictionError(new Error('access_history_changed'));
    return page;
  });
  const page=useProtectedProjection(key,resource.data,()=>{},resource.refresh);
  const label=(kind:string)=>kind.startsWith('department.')?t.auditDepartment:kind.startsWith('access.request.')?t.auditRequest:kind==='access.grant.revoke'?t.auditGrant:kind==='member.access.set'?t.auditMember:kind==='assistant.audience.set'?t.auditAssistant:t.auditOther;
  return <section className="min-w-0 space-y-3 rounded-xl border border-border p-4" aria-label={t.accessAudit}>
    <header className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">{t.accessAudit}</h2><Button className="max-sm:min-h-11" variant="ghost" onClick={close}>{t.close}</Button></header>
    {!page?resource.error?<><p role="alert">{t.historyChanged}</p><Button className="max-sm:min-h-11" onClick={()=>void resource.refresh()}>{t.reload}</Button></>:<SurfaceSkeletonFor surface="organization" chrome={false}/>:<>
      {!page.events.length?<p className="text-sm">{t.auditEmpty}</p>:<ul className="divide-y divide-border">{page.events.map(event=><li key={event.id} className="py-3 text-sm">
        <p>{label(event.kind)}</p><p>{event.actor?.name||t.unnamed}</p><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time>
      </li>)}</ul>}
      {page.nextCursor?<Button variant="outline" className="max-sm:min-h-11" onClick={()=>setAfter(page.nextCursor!)}>{t.olderEvents}</Button>:null}
    </>}
    {after?<Button variant="outline" className="max-sm:min-h-11" onClick={()=>setAfter(undefined)}>{t.newestHistory}</Button>:null}
  </section>;
}

/** Embeds the same human/caller intersection in the existing assistant editor. */
export function AssistantAccessExplanation({assistantId}:{assistantId:string}){
  const {workspaceId,me}=useWorkspaceContext(),t=useT().workspaceAccess;
  const [open,setOpen]=useState(false);
  return <div className="space-y-3"><Button variant="outline" className="max-sm:min-h-11" onClick={()=>setOpen(value=>!value)}>{t.explainAccess}</Button>
    {open?<AssistantExplanationData key={`${workspaceId}:${me.id}:${assistantId}`} assistantId={assistantId} close={()=>setOpen(false)}/>:null}
  </div>;
}
function AssistantExplanationData({assistantId,close}:{assistantId:string;close:()=>void}){
  const {workspaceId,me}=useWorkspaceContext(),t=useT().workspaceAccess;
  const key=workspaceAccessCacheKey(workspaceId,me.id),resource=useCachedResource(key,()=>fetchWorkspaceAccess(workspaceId));
  const data=useProtectedProjection(key,resource.data,close,resource.refresh);
  if(!data)return resource.error?<p role="alert">{t.loadError}</p>:<SurfaceSkeletonFor surface="organization" chrome={false}/>;
  return <AccessExplanationPanel key={data.policyRevision} data={data} memberId={me.id} assistantId={assistantId} close={close}/>;
}
