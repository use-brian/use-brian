"use client";

/** Human-owned scoped integration credentials; secrets never enter shared caches. [COMP:app-web/association] */
import { useEffect, useState, type SetStateAction } from "react";
import { useT } from "@/lib/i18n/client";
import { createCrmCredential,getCrmCredentialBindingOptions,revokeCrmCredential,getCrmCredentialCatalog,getCrmScopeResources,type CrmCredentialGrant,type CrmManagedCredential,type CrmScopeDimension } from "@/lib/api/crm-administration";
import { associationPageCacheKey } from "@/lib/surface-prefetch";
import { ChoiceCards, TechnicalDetails } from "./ui";
import { Button } from "@/components/ui/button";
import { AssociationField,AssociationToggle,AssociationListState,useAssociationAction,useAssociationPage,useAssociationProjection,useAssociationIntent,associationInstant } from "./operator-controls";

type ResourceOptions=Awaited<ReturnType<typeof getCrmScopeResources>>;
function ResourceSelection({dimension,value,onChange,resources,disabled}:{dimension:CrmScopeDimension;value:"all"|string[]|undefined;onChange:(value:"all"|string[]|undefined)=>void;resources:ResourceOptions;disabled:boolean}) {
  const t=useT().associationPage.admin;
  const values=Array.isArray(value)?value:[];
  return <div className="space-y-2 border-l-2 border-border pl-3"><h5 className="text-sm font-medium">{t[dimension]}</h5>
    <AssociationToggle label={t.allResources} checked={value==="all"} disabled={disabled} onChange={checked=>onChange(checked?"all":undefined)}/>
    {value!=="all"&&(dimension==="providerKeys"?<AssociationField label={t.providerKeysInput} multiline value={values.join("\n")} disabled={disabled} onChange={v=>{const selected=v.split("\n");onChange(selected.length?selected:undefined);}}/>:<div className="max-h-48 overflow-y-auto">{resources[dimension].map(row=><AssociationToggle key={row.id} label={`${row.label} (${row.id})`} checked={values.includes(row.id)} disabled={disabled} onChange={checked=>{const next=checked?[...values,row.id]:values.filter(id=>id!==row.id);onChange(next.length?next:undefined);}}/>)}</div>)}
  </div>;
}
type CredentialDraft={label:string;expiry:string;revokeOld:boolean;assistantId:string;cap:"public"|"internal"|"confidential";bindingMode:"default"|"general"|"departments";departmentIds:string[];grants:CrmCredentialGrant[]};
const emptyDraft=():CredentialDraft=>({label:"",expiry:"",grants:[],revokeOld:false,assistantId:"",cap:"internal",bindingMode:"default",departmentIds:[]});
function readDraft(key:string):CredentialDraft {
  try {
    const d=JSON.parse(sessionStorage.getItem(key) ?? "null") as CredentialDraft|null;
    const strings=(value:unknown):value is string[]=>Array.isArray(value)&&value.every(item=>typeof item==="string");
    if(!d||typeof d.label!=="string"||d.label.length>200||typeof d.expiry!=="string"||typeof d.revokeOld!=="boolean"||typeof d.assistantId!=="string"
      ||!["public","internal","confidential"].includes(d.cap)||!["default","general","departments"].includes(d.bindingMode)||!strings(d.departmentIds)
      ||!Array.isArray(d.grants)||!d.grants.every(g=>g&&typeof g.operation==="string"&&g.selectors&&typeof g.selectors==="object"&&!Array.isArray(g.selectors)
        &&Object.values(g.selectors).every(value=>value==="all"||strings(value))))return emptyDraft();
    return {label:d.label,expiry:d.expiry,revokeOld:d.revokeOld,assistantId:d.assistantId,cap:d.cap,bindingMode:d.bindingMode,departmentIds:d.departmentIds,
      grants:d.grants.map(g=>({operation:g.operation,selectors:g.selectors}))};
  } catch {return emptyDraft();}
}
type FormProps={workspaceId:string;rotate?:CrmManagedCredential;disabled:boolean;onSaved:()=>unknown};
export function AssociationCredentialForm(props:FormProps) {
  const draftKey=associationPageCacheKey(props.workspaceId,"credential-draft",{target:props.rotate?.id ?? "new"});
  return props.disabled?null:<CredentialDraftForm key={draftKey} {...props} draftKey={draftKey}/>;
}
function CredentialDraftForm({workspaceId,rotate,disabled,onSaved,draftKey}:FormProps&{draftKey:string}) {
  const t=useT().associationPage,action=useAssociationAction(workspaceId);
  const catalog=useAssociationProjection(disabled?null:associationPageCacheKey(workspaceId,"credential-catalog"),()=>getCrmCredentialCatalog(workspaceId));
  const resources=useAssociationProjection(disabled?null:associationPageCacheKey(workspaceId,"credential-resources"),()=>getCrmScopeResources(workspaceId));
  const [draft,setDraft]=useState(()=>readDraft(draftKey));
  useEffect(()=>{try {sessionStorage.setItem(draftKey,JSON.stringify(draft));}catch{/* Keep the current in-memory draft if storage is unavailable. */}},[draftKey,draft]);
  const {label,expiry,grants,revokeOld,assistantId,cap,bindingMode,departmentIds}=draft;
  function change<K extends keyof CredentialDraft>(key:K,value:SetStateAction<CredentialDraft[K]>) {
    setDraft(previous=>({...previous,[key]:typeof value==="function"?(value as (old:CredentialDraft[K])=>CredentialDraft[K])(previous[key]):value}));
  }
  const setLabel=(v:string)=>change("label",v),setExpiry=(v:string)=>change("expiry",v),setRevokeOld=(v:boolean)=>change("revokeOld",v);
  const setAssistantId=(v:string)=>change("assistantId",v),setCap=(v:string)=>change("cap",v as CredentialDraft["cap"]),setBindingMode=(v:string)=>change("bindingMode",v as CredentialDraft["bindingMode"]);
  const setGrants=(v:SetStateAction<CredentialDraft["grants"]>)=>change("grants",v),setDepartmentIds=(v:SetStateAction<string[]>)=>change("departmentIds",v);
  const binding=useAssociationProjection(disabled?null:associationPageCacheKey(workspaceId,"credential-binding",{assistantId,cap}),()=>getCrmCredentialBindingOptions(workspaceId,{assistantId:assistantId||null,cap}));
  const defaultChoice=binding.data?.choices.find(choice=>choice.selection.departmentIds===undefined);
  const generalChoice=binding.data?.choices.find(choice=>choice.selection.departmentIds?.length===0);
  const departments=binding.data?.choices.flatMap(choice=>choice.selection.departmentIds?.length===1?choice.departments:[]) ?? [];
  const bindingValid=binding.data?.mode==="legacy"||!!binding.data&&(bindingMode==="default"?!!defaultChoice:bindingMode==="general"?!!generalChoice:departmentIds.length>0&&departmentIds.every(id=>departments.some(row=>row.id===id)));
  const intent=useAssociationIntent(workspaceId,"credential-create",rotate?.id ?? "new");
  const [secret,setSecret]=useState<string|null>(null),[attempted,setAttempted]=useState(false),[uncertain,setUncertain]=useState(false);
  const unavailable=disabled||!bindingValid||!!binding.error||!catalog.data||!resources.data||!!catalog.error||!!resources.error||attempted||!!intent.reference||action.pending;
  function selectors(operation:string,dimension:CrmScopeDimension,value:"all"|string[]|undefined){setGrants(rows=>rows.map(row=>{if(row.operation!==operation)return row;const next={...row.selectors};if(value===undefined)delete next[dimension];else next[dimension]=value;return {...row,selectors:next};}));}
  async function newRequest(){if(await intent.reset({title:t.admin.reviewNewKey,description:t.admin.uncertainKey})){setSecret(null);setAttempted(false);setUncertain(false);}}
  return <form className="space-y-4 rounded-xl border border-border p-4" onSubmit={e=>{e.preventDefault();if(unavailable||!grants.length)return;void action.run(t.admin.createKey,async()=>{
    // Once dispatch begins, an uncertain response must not mint another secret on retry.
    const expiresAt=associationInstant(expiry);if(!expiresAt)throw new Error("Explicit expiry required");
    if(intent.hasReference()){setAttempted(true);setUncertain(true);throw new Error("Previous creation must be reviewed");}
    const requestId=intent.identity();setAttempted(true);
    try {const result=await createCrmCredential(workspaceId,{requestId,label,expiresAt,...(binding.data?.mode==="department-v2"?{departmentBinding:{assistantId:assistantId||null,cap,...(bindingMode==="default"?{}:{departmentIds:bindingMode==="general"?[]:departmentIds})}}:{}),grants:grants.map(grant=>({...grant,selectors:Object.fromEntries(Object.entries(grant.selectors).map(([dimension,selection])=>[dimension,Array.isArray(selection)?selection.map(v=>v.trim()).filter(Boolean):selection]))})),...(rotate&&revokeOld?{revokeCredentialId:rotate.id}:{})});setSecret(result.oneTimeSecret);setUncertain(false);}
    catch(error){setUncertain(true);throw error;}finally{void onSaved();}
  });}}>
    <h3 className="font-semibold">{rotate?`${t.admin.rotateKey}: ${rotate.label}`:t.admin.createKey}</h3>
    <fieldset disabled={unavailable} className="space-y-3"><AssociationField label={t.admin.label} required maxLength={200} value={label} onChange={setLabel}/>
      <AssociationField label={t.admin.expiry} type="datetime-local" required value={expiry} onChange={setExpiry}/><p className="text-sm text-muted-foreground">{t.manage.timeHint}</p>
      {rotate?<AssociationToggle label={t.admin.revokeOld} checked={revokeOld} onChange={setRevokeOld}/>:null}
    </fieldset>
    {rotate&&!rotate.departmentBinding?<p role="status" className="text-sm">{t.admin.bindingUnbound}</p>:null}
    {binding.data?.mode!=="legacy"?<div className="space-y-3">
        <ChoiceCards label={t.admin.bindingAssistant} value={assistantId} onChange={setAssistantId} disabled={disabled||action.pending||attempted} options={[{value:"",label:t.admin.bindingNoAssistant},...(binding.data?.assistants ?? []).map(row=>({value:row.id,label:row.name}))]}/>
        <ChoiceCards label={t.admin.bindingCap} value={cap} onChange={setCap} disabled={disabled||action.pending||attempted} options={[{value:"public",label:t.admin.bindingPublic},{value:"internal",label:t.admin.bindingInternal},{value:"confidential",label:t.admin.bindingConfidential}]}/>
    </div>:null}
    <AssociationListState data={binding.data} error={binding.error} refresh={binding.refresh}>
      {binding.data?.mode==="department-v2"?<div className="space-y-3">
        <p className="text-sm text-muted-foreground">{t.admin.credentialBindingHelp}</p>
        <ChoiceCards label={t.admin.bindingTitle} value={bindingMode} onChange={setBindingMode} disabled={disabled||action.pending||attempted} options={[
          ...(defaultChoice?[{value:"default",label:t.ux.destinationDefault,hint:defaultChoice.departments.map(row=>row.name).join(", ")||t.ux.destinationGeneral}]:[]),
          ...(generalChoice?[{value:"general",label:t.ux.destinationGeneral}]:[]),
          ...(departments.length?[{value:"departments",label:t.admin.bindingDepartments}]:[])]}/>
        {bindingMode==="departments"?departments.map(row=><AssociationToggle key={row.id} label={row.name} checked={departmentIds.includes(row.id)} disabled={disabled||action.pending||attempted} onChange={checked=>setDepartmentIds(ids=>checked?[...ids,row.id]:ids.filter(id=>id!==row.id))}/>):null}
        {!bindingValid?<p role="status" className="text-sm">{t.ux.destinationUnavailable}</p>:null}
      </div>:null}
    </AssociationListState>
    <p className="text-sm text-muted-foreground">{t.admin.scopeHelp}</p>
    <AssociationListState data={catalog.data&&resources.data} error={catalog.error||resources.error} refresh={()=>Promise.all([catalog.refresh(),resources.refresh()])}>
      <div className="divide-y divide-border">{catalog.data?.operations.map(operation=>{const selected=grants.find(row=>row.operation===operation);return <div key={operation} className="py-3">
        <AssociationToggle label={(t.admin.operationLabels as Record<string,string>)[operation] ?? t.admin.permissionUnknown} checked={!!selected} disabled={unavailable} onChange={checked=>setGrants(rows=>checked?[...rows,{operation,selectors:{}}]:rows.filter(row=>row.operation!==operation))}/>
        <TechnicalDetails><code>{operation}</code></TechnicalDetails>
        {selected?<div className="space-y-2">{catalog.data!.selectors[operation].length===0?<p className="text-sm text-muted-foreground">{t.admin.workspaceScope}</p>:catalog.data!.selectors[operation].map(dimension=><ResourceSelection key={dimension} dimension={dimension} value={selected.selectors[dimension]} resources={resources.data!} disabled={unavailable} onChange={value=>selectors(operation,dimension,value)}/>)}</div>:null}
      </div>;})}</div>
    </AssociationListState>
    {action.feedback}{(uncertain||!!intent.reference&&!secret)?<p role="alert" className="text-sm text-destructive">{t.admin.uncertainKey}</p>:null}
    {secret?<div className="space-y-2 rounded-xl bg-muted/40 p-3"><p className="text-sm">{t.admin.secretHelp}</p><input className="min-h-8 max-sm:min-h-11 w-full rounded-lg border border-border bg-background px-3 text-base" readOnly autoComplete="off" spellCheck={false} value={secret} aria-label={t.admin.keys} onFocus={e=>e.target.select()}/><Button type="button" className="max-sm:min-h-11" variant="outline" onClick={()=>setSecret(null)}>{t.admin.dismissSecret}</Button></div>:null}
    <div className="flex flex-wrap gap-2"><Button type="submit" className="max-sm:min-h-11" disabled={unavailable||!grants.length}>{t.admin.createKey}</Button>{(attempted||!!intent.reference)?<Button type="button" className="max-sm:min-h-11" variant="outline" disabled={action.pending||disabled} onClick={()=>void newRequest()}>{t.admin.reviewNewKey}</Button>:null}</div>
  </form>;
}
export function AssociationCredentialsPanel(props:{workspaceId:string;disabled:boolean}) {
  const editorKey=associationPageCacheKey(props.workspaceId,"credential-editor");
  return props.disabled?null:<CredentialPanel key={editorKey} {...props} editorKey={editorKey}/>;
}
function CredentialPanel({workspaceId,disabled,editorKey}:{workspaceId:string;disabled:boolean;editorKey:string}) {
  const t=useT().associationPage,rows=useAssociationPage(workspaceId,"credentials",{},!disabled),action=useAssociationAction(workspaceId);
  const [target,setTarget]=useState<string|null>(()=>{try {const value=JSON.parse(sessionStorage.getItem(editorKey) ?? "null");return typeof value==="string"?value:null;}catch{return null;}});
  function setEditing(value:CrmManagedCredential|"new") {const id=value==="new"?value:value.id;setTarget(id);try{sessionStorage.setItem(editorKey,JSON.stringify(id));}catch{}}
  const editing=!rows.error&&rows.data?(target==="new"?"new":rows.data.items.find(row=>row.id===target) ?? null):null;
  return <section className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{t.admin.keys}</h3><Button type="button" className="max-sm:min-h-11" variant="outline" disabled={disabled||!!rows.error} onClick={()=>setEditing("new")}>{t.admin.createKey}</Button></div>
    <AssociationListState {...rows}><div className="divide-y divide-border">{rows.data?.items.map(row=><article key={row.id} className="space-y-2 py-3">
      <p className="text-sm font-medium">{row.label}</p><TechnicalDetails><code className="break-all">{row.id} · {row.prefix}</code></TechnicalDetails><p className="text-sm">{t.admin.expiry}: {new Date(row.expiresAt).toLocaleString()}{row.revokedAt?` · ${t.admin.revoked}`:new Date(row.expiresAt).getTime()<=Date.now()?` · ${t.admin.expired}`:""}</p>
      <details><summary className="max-sm:min-h-11 cursor-pointer py-3 text-sm">{t.admin.permissions}</summary><ul className="space-y-2 break-words text-sm">{row.grants.map(grant=><li key={grant.operation}>{(t.admin.operationLabels as Record<string,string>)[grant.operation] ?? t.admin.permissionUnknown}<TechnicalDetails><code>{grant.operation}</code></TechnicalDetails><ul>{Object.entries(grant.selectors).map(([dimension,selection])=><li key={dimension}>{t.admin[dimension as CrmScopeDimension]}: {selection==="all"?t.admin.allResources:selection?.join(", ")}</li>)}</ul></li>)}</ul></details>
      <div className="flex flex-wrap gap-2"><Button type="button" className="max-sm:min-h-11" variant="outline" disabled={disabled||!!rows.error||action.pending} onClick={()=>setEditing(row)}>{t.admin.rotateKey}</Button><Button type="button" className="max-sm:min-h-11" variant="outline" disabled={disabled||!!rows.error||!!row.revokedAt||action.pending} onClick={()=>void action.run(`${t.admin.revokeKey}: ${row.label}`,()=>revokeCrmCredential(workspaceId,row.id))}>{t.admin.revokeKey}</Button></div>
    </article>)}</div>{rows.data?.items.length===0?<p>{t.manage.empty}</p>:null}</AssociationListState>{action.feedback}
    {editing?<AssociationCredentialForm key={editing==="new"?"new":editing.id} workspaceId={workspaceId} rotate={editing==="new"?undefined:editing} disabled={disabled||!!rows.error} onSaved={()=>rows.refresh()}/>:null}
  </section>;
}
