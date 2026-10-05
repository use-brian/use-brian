"use client";

import {useLayoutEffect,useRef,useState} from "react";
import {useT} from "@/lib/i18n/client";
import {confirmDialog} from "@/components/ui/confirm-dialog";
import {officePanelCacheKey} from "@/lib/surface-prefetch";
import {invalidateSurfaceCache,readSurfaceCache} from "@/lib/surface-cache";
import {officeMetadataRemaining} from "@/lib/office/metadata";
import {useOfficeMetadataResource,useOfficePanelIdentity} from "@/lib/office/surface-cache";
import {getOfficeClassification,restrictOfficeClassification,type OfficeClassification} from "@/lib/office/api";
import {OfficeScopePicker,type OfficeCreationScope} from "../office-scope-picker";

/** Expiring Office metadata, including pending confirmation. [COMP:app-web/office-classification] */
export function OfficeClassificationPanel({artifactId}:{artifactId:string}) {
  const {prefix,viewerId}=useOfficePanelIdentity();
  const key=officePanelCacheKey(prefix,"classification",artifactId);
  const read=useOfficeMetadataResource(key,viewerId,()=>getOfficeClassification(artifactId));
  const t=useT().office;
  if(!key||!read.data)return <p className="text-sm text-muted-foreground">{read.error?t.loadFailed:t.loading}</p>;
  return <ClassificationContent key={`${key}:${read.data.revision}`} cacheKey={key} viewerId={viewerId} artifactId={artifactId} classification={read.data}/>;
}
function ClassificationContent({cacheKey,viewerId,artifactId,classification}:{cacheKey:string;viewerId:string;artifactId:string;classification:OfficeClassification}) {
  const copy=useT(),t=copy.office;
  const [scope,setScope]=useState<OfficeCreationScope|null>(null);
  const [busy,setBusy]=useState(false),[failed,setFailed]=useState(false);
  const life=useRef<AbortController|null>(null);
  useLayoutEffect(()=>{const controller=new AbortController();life.current=controller;return()=>{controller.abort();life.current=null;};},[]);
  const live=()=>{
    const current=readSurfaceCache<OfficeClassification>(cacheKey).data;
    return current?.revision===classification.revision && officeMetadataRemaining(current,viewerId)>0 && current.canManage;
  };
  async function apply() {
    if(!scope||busy||!live()||!life.current)return;
    const signal=life.current.signal;
    const intended=scope;
    setBusy(true);setFailed(false);
    try {
      const approved=await confirmDialog({title:t.restrictClassification,description:t.classificationConfirmation,confirmLabel:t.restrictClassification,cancelLabel:copy.common.cancel,variant:"destructive",signal});
      if(!approved||signal.aborted||!live())return;
      await restrictOfficeClassification(artifactId,{expectedRevision:classification.revision,sensitivity:intended.sensitivity,...(intended.destination.kind==="department"?{departmentId:intended.destination.departmentId}:{})});
      // Evict the old labels, metadata and sharing projection. The root remains
      // the authority for open editors and every subsequent mutation/read.
      invalidateSurfaceCache(cacheKey);
    } catch {if(!signal.aborted)setFailed(true);} finally {if(!signal.aborted)setBusy(false);}
  }
  const label={public:t.sensitivityPublic,internal:t.sensitivityInternal,confidential:t.sensitivityConfidential}[classification.sensitivity];
  const departmentLabel=(key:string)=>classification.departments?.find(d=>`team:${d.id}`===key)?.name ?? key;
  const sensitivityLabel=(value:string)=>({public:t.sensitivityPublic,internal:t.sensitivityInternal,confidential:t.sensitivityConfidential}[value]??value);
  return <section className="space-y-3 py-3">
    <h3 className="text-sm font-medium">{t.departmentAccess}</h3>
    <p className="break-words text-sm">{label} · {classification.compartments.length ? classification.compartments.map(departmentLabel).join(", ") : t.generalDepartment}</p>
    {classification.canManage ? <>
      <OfficeScopePicker workspaceId={classification.workspaceId} minimumSensitivity={classification.sensitivity} restricting onChange={setScope}/>
      <p className="text-xs text-muted-foreground">{t.classificationConfirmation}</p>
      <button type="button" disabled={!scope||busy} onClick={()=>void apply()} className="min-h-8 max-sm:min-h-11 rounded-md border px-3 text-sm font-medium disabled:opacity-50">{t.restrictClassification}</button>
    </> : null}
    {classification.history.length ? <details><summary className="min-h-8 max-sm:min-h-11 cursor-pointer py-3 text-sm">{t.classificationHistory}</summary><ul className="space-y-2 text-xs">{classification.history.map(event=><li key={event.id} className="break-words">{new Date(event.createdAt).toLocaleString()} · {sensitivityLabel(event.metadata.before.sensitivity)} → {sensitivityLabel(event.metadata.after.sensitivity)} · {event.metadata.after.compartments.map(departmentLabel).join(", ") || t.generalDepartment}</li>)}</ul></details> : null}
    {failed?<p role="alert" className="text-sm text-destructive">{t.classificationFailed}</p>:null}
  </section>;
}
