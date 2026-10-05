"use client";

/** Owner/admin Office grant and workspace-default management. [COMP:app-web/office-history-sharing] */
import {OfficeClassificationPanel} from "./office-classification";
import {useLayoutEffect,useMemo,useRef,useState} from "react";
import {getOfficeSharing,revokeOfficeGrant,setOfficeDefaultRole,setOfficeGrant,OfficeApiError,type OfficeSharing as SharingState} from "@/lib/office/api";
import {useT} from "@/lib/i18n/client";
import {confirmDialog} from "@/components/ui/confirm-dialog";
import {SearchableSelect} from "@/components/ui/searchable-select";
import {officePanelCacheKey} from "@/lib/surface-prefetch";
import {publishOfficeMetadataResource,useOfficeMetadataResource,useOfficePanelIdentity} from "@/lib/office/surface-cache";
import {invalidateSurfaceCache,readSurfaceCache} from "@/lib/surface-cache";
import {officeMetadataRemaining} from "@/lib/office/metadata";

const ROLES=["view","comment","edit"] as const;
type Role=typeof ROLES[number];

export function OfficeSharing({artifactId}:{artifactId:string}){
  const t=useT().office;
  const {prefix,viewerId}=useOfficePanelIdentity();
  const cacheKey=officePanelCacheKey(prefix,"sharing",artifactId);
  const read=useOfficeMetadataResource(cacheKey,viewerId,()=>getOfficeSharing(artifactId));
  if(!read.data||!cacheKey)return <p className="text-xs text-muted-foreground">{read.error?t.loadFailed:t.sharingLoading}</p>;
  return <OfficeSharingContent key={cacheKey} artifactId={artifactId} sharing={read.data} cacheKey={cacheKey} viewerId={viewerId}/>;
}

function OfficeSharingContent({artifactId,sharing,cacheKey,viewerId}:{artifactId:string;sharing:SharingState;cacheKey:string;viewerId:string}){
  const t=useT().office;
  const [busy,setBusy]=useState(false),[failed,setFailed]=useState(false);
  const lifetime=useRef<AbortController|null>(null),pending=useRef<AbortController|null>(null);
  useLayoutEffect(()=>{const owner=new AbortController();lifetime.current=owner;return()=>{owner.abort();pending.current?.abort();pending.current=null;lifetime.current=null;};},[]);
  const roleItems=useMemo(()=>ROLES.map(role=>({value:role,label:roleLabel(role,t)})),[t]);
  const liveGrants=new Map(sharing.grants.filter(grant=>!grant.revokedAt&&grant.role!=="deny").map(grant=>[grant.userId,grant.role as Role]));

  async function run(targetUserId:string|null,action:(signal:AbortSignal)=>Promise<SharingState>){
    const owner=lifetime.current,controller=new AbortController();
    const current=()=>{const value=readSurfaceCache<SharingState>(cacheKey).data;return Boolean(owner&&owner===lifetime.current&&!owner.signal.aborted&&!controller.signal.aborted&&officeMetadataRemaining(value,viewerId)>0&&value?.canManage&&(!targetUserId||value.members.some(member=>member.userId===targetUserId)));};
    if(!owner||pending.current||busy||!current())return;
    pending.current=controller;setBusy(true);setFailed(false);
    try{const published=await action(controller.signal);if(current())publishOfficeMetadataResource(cacheKey,published,viewerId);}
    catch(error){if(error instanceof DOMException&&error.name==="AbortError")return;if(current()){if(error instanceof OfficeApiError&&[401,403,404].includes(error.status))invalidateSurfaceCache(cacheKey);else setFailed(true);}}
    finally{if(pending.current===controller)pending.current=null;if(owner===lifetime.current&&!owner.signal.aborted)setBusy(false);}
  }

  function changeDefault(role:Role){
    if(role===sharing.defaultWorkspaceRole)return;
    return run(null,async signal=>{
      const confirmed=await confirmDialog({title:t.changeDefaultRole,description:t.changeDefaultRoleDescription.replace("{role}",roleLabel(role,t)),confirmLabel:t.changeRole,cancelLabel:t.cancel,signal});
      if(!confirmed)throw new DOMException("Cancelled","AbortError");
      return setOfficeDefaultRole(artifactId,role);
    });
  }
  function changeMember(userId:string,role:Role){return run(userId,async signal=>{
    const confirmed=await confirmDialog({title:t.changeMemberRole,description:t.changeMemberRoleDescription.replace("{role}",roleLabel(role,t)),confirmLabel:t.changeRole,cancelLabel:t.cancel,signal});
    if(!confirmed)throw new DOMException("Cancelled","AbortError");
    return setOfficeGrant(artifactId,userId,role);
  });}
  function inheritDefault(userId:string){return run(userId,async signal=>{
    const confirmed=await confirmDialog({title:t.removeSpecificAccess,description:t.removeSpecificAccessDescription,confirmLabel:t.removeSpecificAccess,cancelLabel:t.cancel,signal});
    if(!confirmed)throw new DOMException("Cancelled","AbortError");
    return revokeOfficeGrant(artifactId,userId);
  });}

  return <section aria-label={t.sharing} className="space-y-3"><h2 className="text-sm font-semibold">{t.sharing}</h2><OfficeClassificationPanel artifactId={artifactId}/><div className="rounded-lg border p-3"><p className="text-xs font-medium">{t.workspaceDefault}</p><p className="mb-2 text-xs text-muted-foreground">{t.workspaceDefaultDescription}</p><SearchableSelect value={sharing.defaultWorkspaceRole} onValueChange={value=>void changeDefault(value as Role)} items={roleItems} disabled={busy||!sharing.canManage} aria-label={t.workspaceDefault} searchPlaceholder={t.searchRoles} emptyMessage={t.noRoles}/></div><div className="space-y-2">{sharing.members.map(member=>{const explicit=liveGrants.get(member.userId),effective=member.isOwner?"edit":explicit??sharing.defaultWorkspaceRole;return <article key={member.userId} className="rounded-lg border p-3"><p className="truncate text-xs font-medium">{member.userName||member.email||t.member}</p>{member.email?<p className="truncate text-[11px] text-muted-foreground">{member.email}</p>:null}<div className="mt-2"><SearchableSelect value={effective} onValueChange={value=>void changeMember(member.userId,value as Role)} items={roleItems} disabled={busy||!sharing.canManage||member.isOwner} aria-label={t.memberRole.replace("{member}",member.userName||member.email||t.member)} searchPlaceholder={t.searchRoles} emptyMessage={t.noRoles}/></div>{member.isOwner?<p className="mt-1 text-[11px] text-muted-foreground">{t.ownerAlwaysEditor}</p>:explicit&&sharing.canManage?<button type="button" disabled={busy} onClick={()=>void inheritDefault(member.userId)} className="mt-1 text-[11px] text-muted-foreground hover:underline">{t.useWorkspaceDefault}</button>:null}</article>;})}</div>{failed?<p role="alert" className="text-xs text-destructive">{t.loadFailed}</p>:null}</section>;
}

function roleLabel(role:Role,t:ReturnType<typeof useT>["office"]):string{return {view:t.viewer,comment:t.commenter,edit:t.editorRole}[role];}
