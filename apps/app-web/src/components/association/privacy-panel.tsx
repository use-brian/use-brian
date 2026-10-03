"use client";

/** Human-reviewed privacy execution and complete, verified exports. [COMP:app-web/association] */
import {useRef,useState} from "react";
import {useT} from "@/lib/i18n/client";
import type {CrmLookupRow} from "@/lib/api/crm";
import {getCrmFullPrivacyPolicy,previewCrmPrivacy,executeCrmPrivacy,getCrmFileCleanupReceipt,downloadCrmFullPrivacy,type CrmPrivacyPreview,type CrmPrivacyPreviewRequest,type CrmPrivacyPolicySnapshot} from "@/lib/api/crm-administration";
import {associationPageCacheKey} from "@/lib/surface-prefetch";
import {useCachedResource} from "@/lib/surface-cache";
import {Button} from "@/components/ui/button";
import {AssociationField,AssociationContactPicker,AssociationListState,useAssociationAction,useAssociationPage,associationInstant} from "./operator-controls";
import {AssociationPrivacyPolicyForm} from "./privacy-policy-form";

export function AssociationPrivacyReview({workspaceId,kind,disabled}:{workspaceId:string;kind:CrmPrivacyPreviewRequest["kind"];disabled:boolean}) {
  const t=useT().associationPage,p=t.privacy,action=useAssociationAction(workspaceId),lock=useRef(false);
  const [contact,setContact]=useState<CrmLookupRow|null>(null),[fileId,setFileId]=useState(""),[before,setBefore]=useState("");
  const [preview,setPreview]=useState<{request:CrmPrivacyPreviewRequest;review:CrmPrivacyPreview}|null>(null),[receipt,setReceipt]=useState<Record<string,unknown>|null>(null);
  const [reading,setReading]=useState(false),[readError,setReadError]=useState(false),[attempted,setAttempted]=useState(false),[executeError,setExecuteError]=useState(false);
  const busy=disabled||reading||action.pending;
  function changed(){setPreview(null);setReceipt(null);setAttempted(false);setReadError(false);setExecuteError(false);}
  async function loadPreview(){
    if(busy||lock.current||kind==="erasure"&&!contact||kind!=="erasure"&&!before||kind==="fileCleanup"&&!fileId)return;
    lock.current=true;setReading(true);setReadError(false);setPreview(null);setReceipt(null);setAttempted(false);setExecuteError(false);
    try {const request:CrmPrivacyPreviewRequest=kind==="erasure"?{kind,contactId:contact!.id}:kind==="retention"?{kind,before:associationInstant(before)!}:{kind,fileId:fileId.trim(),before:associationInstant(before)!};const review=await previewCrmPrivacy(workspaceId,request);setPreview({request,review});}
    catch{setReadError(true);}finally{lock.current=false;setReading(false);}
  }
  const review=preview?.review,expired=review?Date.parse(review.expiresAt)<=Date.now():false;
  const canExecute=!!review&&review.status==="ready"&&!review.blockers.length&&(!expired||attempted)&&!busy;
  async function execute(){
    if(!canExecute||!preview)return;
    await action.run(p.execute,async()=>{setExecuteError(false);try{if(!attempted&&Date.parse(preview.review.expiresAt)<=Date.now())throw new Error("Preview expired");setAttempted(true);setReceipt(await executeCrmPrivacy(workspaceId,preview.request,preview.review));}catch(error){setExecuteError(true);throw error;}},{description:p.executeConfirm});
  }
  async function refreshReceipt(){if(!preview||kind!=="fileCleanup"||busy)return;setReading(true);setReadError(false);try{setReceipt(await getCrmFileCleanupReceipt(workspaceId,preview.review.id));}catch{setReadError(true);}finally{setReading(false);}}
  return <section className="space-y-4 rounded-xl border border-border p-4"><h3 className="font-semibold">{p[kind]}</h3>
    <form className="space-y-3" onSubmit={e=>{e.preventDefault();void loadPreview();}}><fieldset disabled={busy} className="space-y-3">
      {kind==="erasure"?<><AssociationContactPicker workspaceId={workspaceId} onSelect={row=>{changed();setContact(row);}}/><p className="text-sm">{contact?.name ?? t.manage.contactRequired}</p></>:null}
      {kind==="fileCleanup"?<AssociationField label={p.fileId} required value={fileId} onChange={value=>{changed();setFileId(value);}} pattern="[a-fA-F0-9-]{36}" maxLength={36}/>:null}
      {kind!=="erasure"?<AssociationField label={p.before} type="datetime-local" required value={before} onChange={value=>{changed();setBefore(value);}}/>:null}
    </fieldset><Button type="submit" className="max-sm:min-h-11" variant="outline" disabled={busy||kind==="erasure"&&!contact}>{p.preview}</Button></form>
    {readError?<p role="alert" className="text-sm text-destructive">{receipt?t.manage.loadFailed:p.previewFailed}</p>:null}
    {review?<div className="space-y-3"><p className="text-sm">{p[review.status]} · {t.admin.readVersion}: {review.policyVersion}</p><p className="text-sm">{t.admin.expiry}: {new Date(review.expiresAt).toLocaleString()}</p><p className="break-all text-xs text-muted-foreground">{review.id} / {review.previewHash}</p>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">{p.domain}</th><th className="p-2">{p.action}</th><th className="p-2">{p.count}</th></tr></thead><tbody>{review.domains.map(row=><tr key={`${row.domain}:${row.action}`}><td className="p-2">{row.domain}</td><td className="p-2">{p[row.action]}</td><td className="p-2 tabular-nums">{row.count}</td></tr>)}</tbody></table></div>
      {review.blockers.length?<div><h4 className="text-sm font-medium">{p.blockers}</h4><ul className="list-inside list-disc text-sm">{review.blockers.map((row,i)=><li key={i}>{row.domain}: {row.reason} ({row.count})</li>)}</ul></div>:null}
      {(review.scopeLimits?.length||review.retainedCopies?.length)?<div><h4 className="text-sm font-medium">{p.limits}</h4><ul className="list-inside list-disc text-sm">{[...(review.scopeLimits ?? []),...(review.retainedCopies ?? [])].map((limit,i)=><li key={i}>{limit}</li>)}</ul></div>:null}
      {review.cutoffs?<dl className="grid gap-2 text-sm md:grid-cols-2">{Object.entries(review.cutoffs).map(([domain,cutoff])=><div key={domain}><dt>{domain}</dt><dd>{cutoff?new Date(cutoff).toLocaleString():t.admin.unconfigured}</dd></div>)}</dl>:null}
      {review.hasMore?<p className="text-sm text-muted-foreground">{p.more}</p>:null}{expired&&!attempted?<p role="alert" className="text-sm text-destructive">{p.expired}</p>:null}
      <Button type="button" className="max-sm:min-h-11" disabled={!canExecute} onClick={()=>void execute()}>{p.execute}</Button>
    </div>:null}{executeError?<p role="alert" className="text-sm text-destructive">{p.executeFailed}</p>:action.feedback}
    {receipt?<section className="space-y-2"><h4 className="font-medium">{p.receipt}</h4><pre className="max-h-72 overflow-auto rounded-lg bg-muted p-3 text-xs" aria-label={p.receipt}>{JSON.stringify(receipt,null,2)}</pre>
      {kind==="fileCleanup"?<><p className="text-sm text-muted-foreground">{p.receiptHelp}</p><Button type="button" className="max-sm:min-h-11" variant="outline" disabled={busy} onClick={()=>void refreshReceipt()}>{t.refresh}</Button></>:null}
    </section>:null}
  </section>;
}
function PrivacyExport({workspaceId,disabled}:{workspaceId:string;disabled:boolean}) {
  const t=useT().associationPage,p=t.privacy;
  const [contact,setContact]=useState<CrmLookupRow|null>(null),[pending,setPending]=useState(false),[error,setError]=useState(false);const lock=useRef(false);
  async function download(contactId?:string){if(disabled||lock.current)return;lock.current=true;setPending(true);setError(false);try{const blob=await downloadCrmFullPrivacy(workspaceId,contactId),url=URL.createObjectURL(blob),anchor=document.createElement("a");anchor.href=url;anchor.download=`crm-privacy-${contactId ?? workspaceId}.ndjson`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),0);}catch{setError(true);}finally{lock.current=false;setPending(false);}}
  return <section className="space-y-3 rounded-xl border border-border p-4"><p className="text-sm text-muted-foreground">{p.exportHelp}</p><Button type="button" className="max-sm:min-h-11" variant="outline" disabled={disabled||pending} onClick={()=>void download()}>{p.workspaceExport}</Button>
    <fieldset disabled={disabled||pending}><AssociationContactPicker workspaceId={workspaceId} onSelect={setContact}/></fieldset><p className="text-sm">{contact?.name ?? t.manage.contactRequired}</p><Button type="button" className="max-sm:min-h-11" variant="outline" disabled={disabled||pending||!contact} onClick={()=>void download(contact!.id)}>{p.contactExport}</Button>
    {error?<p role="alert" className="text-sm text-destructive">{p.exportFailed}</p>:null}
  </section>;
}
export function AssociationPrivacyPanel({workspaceId,disabled}:{workspaceId:string;disabled:boolean}) {
  const t=useT().associationPage,p=t.privacy;
  const policy=useCachedResource(associationPageCacheKey(workspaceId,"privacy-policy"),()=>getCrmFullPrivacyPolicy(workspaceId));
  const runs=useAssociationPage(workspaceId,"retentionRuns");
  const [editing,setEditing]=useState<CrmPrivacyPolicySnapshot|null>(null),[kind,setKind]=useState<CrmPrivacyPreviewRequest["kind"]>("erasure");
  return <section className="space-y-5"><h3 className="font-semibold">{p.title}</h3><AssociationListState {...policy}><p className="text-sm">{p.policy} · {t.admin.readVersion}: {policy.data?.version ?? 0}</p><p className="text-sm text-muted-foreground">{p.policyHelp}</p><Button type="button" className="max-sm:min-h-11" variant="outline" disabled={disabled||!!policy.error||!policy.data} onClick={()=>setEditing(policy.data!)}>{t.manage.edit}</Button></AssociationListState>
    {editing?<AssociationPrivacyPolicyForm key={editing.version} workspaceId={workspaceId} snapshot={editing} disabled={disabled||!!policy.error} onSaved={()=>{setEditing(null);void policy.refresh();}}/>:null}
    <div className="flex flex-wrap gap-2">{(["erasure","retention","fileCleanup"] as const).map(value=><Button key={value} type="button" className="max-sm:min-h-11" variant={value===kind?"secondary":"outline"} aria-pressed={value===kind} onClick={()=>setKind(value)}>{p[value]}</Button>)}</div>
    <AssociationPrivacyReview key={kind} workspaceId={workspaceId} kind={kind} disabled={disabled}/>
    <PrivacyExport workspaceId={workspaceId} disabled={disabled}/>
    <h3 className="font-semibold">{p.runs}</h3><AssociationListState {...runs}><div className="divide-y divide-border">{runs.data?.items.map(run=><details key={run.id}><summary className="max-sm:min-h-11 cursor-pointer py-3 text-sm">{run.status} · {new Date(run.createdAt).toLocaleString()}</summary><pre className="max-h-72 overflow-auto rounded-lg bg-muted p-3 text-xs">{JSON.stringify(run,null,2)}</pre></details>)}</div>{runs.data?.items.length===0?<p>{t.manage.empty}</p>:null}</AssociationListState>
  </section>;
}
