"use client";

/** Human-owned scoped integration credentials; secrets never enter shared caches. [COMP:app-web/association] */
import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { createCrmCredential,revokeCrmCredential,getCrmCredentialCatalog,getCrmScopeResources,type CrmCredentialGrant,type CrmManagedCredential,type CrmScopeDimension } from "@/lib/api/crm-administration";
import { associationPageCacheKey } from "@/lib/surface-prefetch";
import { useCachedResource } from "@/lib/surface-cache";
import { Button } from "@/components/ui/button";
import { AssociationField,AssociationToggle,AssociationListState,useAssociationAction,useAssociationPage,useAssociationIntent,associationInstant } from "./operator-controls";

type ResourceOptions=Awaited<ReturnType<typeof getCrmScopeResources>>;
function ResourceSelection({dimension,value,onChange,resources,disabled}:{dimension:CrmScopeDimension;value:"all"|string[]|undefined;onChange:(value:"all"|string[]|undefined)=>void;resources:ResourceOptions;disabled:boolean}) {
  const t=useT().associationPage.admin;
  const values=Array.isArray(value)?value:[];
  return <div className="space-y-2 border-l-2 border-border pl-3"><h5 className="text-sm font-medium">{t[dimension]}</h5>
    <AssociationToggle label={t.allResources} checked={value==="all"} disabled={disabled} onChange={checked=>onChange(checked?"all":undefined)}/>
    {value!=="all"&&(dimension==="providerKeys"?<AssociationField label={t.providerKeysInput} multiline value={values.join("\n")} disabled={disabled} onChange={v=>{const selected=v.split("\n");onChange(selected.length?selected:undefined);}}/>:<div className="max-h-48 overflow-y-auto">{resources[dimension].map(row=><AssociationToggle key={row.id} label={`${row.label} (${row.id})`} checked={values.includes(row.id)} disabled={disabled} onChange={checked=>{const next=checked?[...values,row.id]:values.filter(id=>id!==row.id);onChange(next.length?next:undefined);}}/>)}</div>)}
  </div>;
}
export function AssociationCredentialForm({workspaceId,rotate,disabled,onSaved}:{workspaceId:string;rotate?:CrmManagedCredential;disabled:boolean;onSaved:()=>unknown}) {
  const t=useT().associationPage,action=useAssociationAction(workspaceId);
  const catalog=useCachedResource(associationPageCacheKey(workspaceId,"credential-catalog"),()=>getCrmCredentialCatalog(workspaceId));
  const resources=useCachedResource(associationPageCacheKey(workspaceId,"credential-resources"),()=>getCrmScopeResources(workspaceId));
  const [label,setLabel]=useState(""),[expiry,setExpiry]=useState(""),[grants,setGrants]=useState<CrmCredentialGrant[]>([]),[revokeOld,setRevokeOld]=useState(false);
  const intent=useAssociationIntent(workspaceId,"credential-create",rotate?.id ?? "new");
  const [secret,setSecret]=useState<string|null>(null),[attempted,setAttempted]=useState(false),[uncertain,setUncertain]=useState(false);
  const unavailable=disabled||!catalog.data||!resources.data||!!catalog.error||!!resources.error||attempted||!!intent.reference||action.pending;
  function selectors(operation:string,dimension:CrmScopeDimension,value:"all"|string[]|undefined){setGrants(rows=>rows.map(row=>{if(row.operation!==operation)return row;const next={...row.selectors};if(value===undefined)delete next[dimension];else next[dimension]=value;return {...row,selectors:next};}));}
  async function newRequest(){if(await intent.reset({title:t.admin.reviewNewKey,description:t.admin.uncertainKey})){setSecret(null);setAttempted(false);setUncertain(false);}}
  return <form className="space-y-4 rounded-xl border border-border p-4" onSubmit={e=>{e.preventDefault();if(unavailable||!grants.length)return;void action.run(t.admin.createKey,async()=>{
    // Once dispatch begins, an uncertain response must not mint another secret on retry.
    const expiresAt=associationInstant(expiry);if(!expiresAt)throw new Error("Explicit expiry required");
    if(intent.hasReference()){setAttempted(true);setUncertain(true);throw new Error("Previous creation must be reviewed");}
    intent.identity();setAttempted(true);
    try {const result=await createCrmCredential(workspaceId,{label,expiresAt,grants:grants.map(grant=>({...grant,selectors:Object.fromEntries(Object.entries(grant.selectors).map(([dimension,selection])=>[dimension,Array.isArray(selection)?selection.map(v=>v.trim()).filter(Boolean):selection]))})),...(rotate&&revokeOld?{revokeCredentialId:rotate.id}:{})});setSecret(result.oneTimeSecret);setUncertain(false);}
    catch(error){setUncertain(true);throw error;}finally{void onSaved();}
  });}}>
    <h3 className="font-semibold">{rotate?`${t.admin.rotateKey}: ${rotate.label}`:t.admin.createKey}</h3>
    <fieldset disabled={unavailable} className="space-y-3"><AssociationField label={t.admin.label} required maxLength={200} value={label} onChange={setLabel}/>
      <AssociationField label={t.admin.expiry} type="datetime-local" required value={expiry} onChange={setExpiry}/><p className="text-sm text-muted-foreground">{t.manage.timeHint}</p>
      {rotate?<AssociationToggle label={t.admin.revokeOld} checked={revokeOld} onChange={setRevokeOld}/>:null}
    </fieldset>
    <p className="text-sm text-muted-foreground">{t.admin.scopeHelp}</p>
    <AssociationListState data={catalog.data&&resources.data} error={catalog.error||resources.error} refresh={()=>Promise.all([catalog.refresh(),resources.refresh()])}>
      <div className="divide-y divide-border">{catalog.data?.operations.map(operation=>{const selected=grants.find(row=>row.operation===operation);return <div key={operation} className="py-3">
        <AssociationToggle label={operation} checked={!!selected} disabled={unavailable} onChange={checked=>setGrants(rows=>checked?[...rows,{operation,selectors:{}}]:rows.filter(row=>row.operation!==operation))}/>
        {selected?<div className="space-y-2">{catalog.data!.selectors[operation].length===0?<p className="text-sm text-muted-foreground">{t.admin.workspaceScope}</p>:catalog.data!.selectors[operation].map(dimension=><ResourceSelection key={dimension} dimension={dimension} value={selected.selectors[dimension]} resources={resources.data!} disabled={unavailable} onChange={value=>selectors(operation,dimension,value)}/>)}</div>:null}
      </div>;})}</div>
    </AssociationListState>
    {action.feedback}{(uncertain||!!intent.reference&&!secret)?<p role="alert" className="text-sm text-destructive">{t.admin.uncertainKey}</p>:null}
    {secret?<div className="space-y-2 rounded-xl bg-muted/40 p-3"><p className="text-sm">{t.admin.secretHelp}</p><input className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-base" readOnly autoComplete="off" spellCheck={false} value={secret} aria-label={t.admin.keys} onFocus={e=>e.target.select()}/><Button type="button" className="min-h-11" variant="outline" onClick={()=>setSecret(null)}>{t.admin.dismissSecret}</Button></div>:null}
    <div className="flex flex-wrap gap-2"><Button type="submit" className="min-h-11" disabled={unavailable||!grants.length}>{t.admin.createKey}</Button>{(attempted||!!intent.reference)?<Button type="button" className="min-h-11" variant="outline" disabled={action.pending||disabled} onClick={()=>void newRequest()}>{t.admin.reviewNewKey}</Button>:null}</div>
  </form>;
}
export function AssociationCredentialsPanel({workspaceId,disabled}:{workspaceId:string;disabled:boolean}) {
  const t=useT().associationPage,rows=useAssociationPage(workspaceId,"credentials",{},!disabled),action=useAssociationAction(workspaceId);
  const [editing,setEditing]=useState<CrmManagedCredential|"new"|null>(null);
  return <section className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{t.admin.keys}</h3><Button type="button" className="min-h-11" variant="outline" disabled={disabled||!!rows.error} onClick={()=>setEditing("new")}>{t.admin.createKey}</Button></div>
    <AssociationListState {...rows}><div className="divide-y divide-border">{rows.data?.items.map(row=><article key={row.id} className="space-y-2 py-3">
      <p className="text-sm font-medium">{row.label}</p><p className="break-all text-xs text-muted-foreground">{row.id} · {row.prefix}</p><p className="text-sm">{t.admin.expiry}: {new Date(row.expiresAt).toLocaleString()}{row.revokedAt?` · ${t.admin.revoked}`:new Date(row.expiresAt).getTime()<=Date.now()?` · ${t.admin.expired}`:""}</p>
      <details><summary className="min-h-11 cursor-pointer py-3 text-sm">{t.admin.permissions}</summary><ul className="space-y-2 break-words text-sm">{row.grants.map(grant=><li key={grant.operation}>{grant.operation}<ul>{Object.entries(grant.selectors).map(([dimension,selection])=><li key={dimension}>{t.admin[dimension as CrmScopeDimension]}: {selection==="all"?t.admin.allResources:selection?.join(", ")}</li>)}</ul></li>)}</ul></details>
      <div className="flex flex-wrap gap-2"><Button type="button" className="min-h-11" variant="outline" disabled={disabled||!!rows.error||action.pending} onClick={()=>setEditing(row)}>{t.admin.rotateKey}</Button><Button type="button" className="min-h-11" variant="outline" disabled={disabled||!!rows.error||!!row.revokedAt||action.pending} onClick={()=>void action.run(`${t.admin.revokeKey}: ${row.label}`,()=>revokeCrmCredential(workspaceId,row.id))}>{t.admin.revokeKey}</Button></div>
    </article>)}</div>{rows.data?.items.length===0?<p>{t.manage.empty}</p>:null}</AssociationListState>{action.feedback}
    {editing?<AssociationCredentialForm key={editing==="new"?"new":editing.id} workspaceId={workspaceId} rotate={editing==="new"?undefined:editing} disabled={disabled||!!rows.error} onSaved={()=>rows.refresh()}/>:null}
  </section>;
}
