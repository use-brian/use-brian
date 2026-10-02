"use client";

/** Reviewed mailbox policies and exact credential bindings. [COMP:app-web/association] */
import {useState} from "react";
import {useT} from "@/lib/i18n/client";
import {listCrmConsentPurposes} from "@/lib/api/crm";
import {listCrmMailboxes,getCrmMailboxPolicy,saveCrmMailboxPolicy,getCrmMailboxGrant,saveCrmMailboxGrant,type CrmManagedMailboxPolicy,type CrmManagedCredential} from "@/lib/api/crm-administration";
import {associationPageCacheKey} from "@/lib/surface-prefetch";
import {useCachedResource} from "@/lib/surface-cache";
import {Button} from "@/components/ui/button";
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from "@/components/ui/select";
import {AssociationField,AssociationToggle,AssociationListState,useAssociationAction,useAssociationPage} from "./operator-controls";

export function AssociationMailboxPolicyForm({workspaceId,instanceId,policy,disabled,onSaved}:{workspaceId:string;instanceId:string;policy:CrmManagedMailboxPolicy|null;disabled:boolean;onSaved:()=>void}) {
  const t=useT().associationPage,action=useAssociationAction(workspaceId);
  const purposes=useCachedResource(associationPageCacheKey(workspaceId,"all-consent-purposes"),()=>listCrmConsentPurposes(workspaceId,true));
  const [provider,setProvider]=useState(policy?.providerKey ?? ""),[managed,setManaged]=useState(policy?.managed ?? false),[selected,setSelected]=useState(policy?.purposeKeys ?? []);
  const [templates,setTemplates]=useState(()=>Object.entries(policy?.templatePurposes ?? {}).map(([key,purpose],i)=>({id:`existing-${i}`,key,purpose})));
  const unavailable=disabled||action.pending||!purposes.data||!!purposes.error;
  return <form className="space-y-3 rounded-xl border border-border p-4" onSubmit={e=>{e.preventDefault();if(unavailable)return;void action.run(t.manage.save,async()=>{
    if(new Set(templates.map(row=>row.key.trim())).size!==templates.length)throw new Error("Template identities must be unique");
    await saveCrmMailboxPolicy(workspaceId,instanceId,{expectedVersion:policy?.version ?? 0,confirmed:true,providerKey:provider,managed,purposeKeys:selected,templatePurposes:Object.fromEntries(templates.map(row=>[row.key.trim(),row.purpose]))});onSaved();
  });}}>
    <p className="text-sm">{t.admin.readVersion}: {policy?.version ?? 0}</p><fieldset disabled={unavailable} className="space-y-3">
      <AssociationField label={t.admin.providerKey} required maxLength={63} value={provider} disabled={!!policy} onChange={setProvider}/><p className="text-sm text-muted-foreground">{t.admin.providerKeyHelp}</p>
      <AssociationToggle label={t.admin.managed} checked={managed} onChange={setManaged} disabled={unavailable}/>
      <AssociationListState {...purposes}><h4 className="text-sm font-medium">{t.admin.purposes}</h4><div className="max-h-48 overflow-y-auto">
        {purposes.data?.filter(row=>row.applicableChannels.includes("email")||selected.includes(row.purposeKey)).map(row=><AssociationToggle key={row.purposeKey} label={`${row.label} (${row.purposeKey})`} checked={selected.includes(row.purposeKey)} disabled={unavailable||!!row.archivedAt&&!selected.includes(row.purposeKey)} onChange={checked=>setSelected(values=>checked?[...values,row.purposeKey]:values.filter(key=>key!==row.purposeKey))}/>)}
        {selected.filter(key=>!purposes.data?.some(row=>row.purposeKey===key)).map(key=><AssociationToggle key={key} label={key} checked disabled={unavailable} onChange={()=>setSelected(values=>values.filter(value=>value!==key))}/>)}
      </div></AssociationListState>
      <h4 className="text-sm font-medium">{t.admin.templates}</h4>
      {templates.map(row=><div key={row.id} className="space-y-2 border-t border-border pt-3"><AssociationField label={t.admin.templateKey} required maxLength={63} value={row.key} onChange={key=>setTemplates(values=>values.map(item=>item.id===row.id?{...item,key}:item))}/>
        <Select value={row.purpose} disabled={unavailable} onValueChange={value=>{if(value)setTemplates(values=>values.map(item=>item.id===row.id?{...item,purpose:value}:item));}}><SelectTrigger aria-label={t.manage.purpose} className="min-h-11 w-full"><SelectValue placeholder={t.manage.choose}/></SelectTrigger><SelectContent>{selected.map(key=><SelectItem key={key} value={key}>{purposes.data?.find(p=>p.purposeKey===key)?.label ?? key}</SelectItem>)}</SelectContent></Select>
        <Button type="button" className="min-h-11" variant="ghost" onClick={()=>setTemplates(values=>values.filter(item=>item.id!==row.id))}>{t.admin.removeTemplate}</Button>
      </div>)}
      <Button type="button" className="min-h-11" variant="outline" disabled={templates.length>=200} onClick={()=>setTemplates(values=>[...values,{id:crypto.randomUUID(),key:"",purpose:""}])}>{t.admin.addTemplate}</Button>
    </fieldset>{action.feedback}<Button type="submit" className="min-h-11" disabled={unavailable}>{t.manage.save}</Button>
  </form>;
}
export function AssociationMailboxGrantControl({workspaceId,instanceId,credential,disabled}:{workspaceId:string;instanceId:string;credential:CrmManagedCredential;disabled:boolean}) {
  const t=useT().associationPage,action=useAssociationAction(workspaceId);
  const grant=useCachedResource(associationPageCacheKey(workspaceId,"mailbox-grant",{instanceId,credentialId:credential.id}),()=>getCrmMailboxGrant(workspaceId,instanceId,credential.id));
  const enabled=!!grant.data?.grant?.enabled;
  return <section className="space-y-2 rounded-xl border border-border p-3"><h4 className="text-sm font-medium">{credential.label}</h4><p className="text-sm text-muted-foreground">{t.admin.bindingHelp}</p>
    <AssociationListState {...grant}><p className="text-sm">{t.admin.readVersion}: {grant.data?.grant?.version ?? 0}</p><AssociationToggle label={t.admin.allowMailbox} checked={enabled} disabled={disabled||!!grant.error||!grant.data||action.pending||!enabled&&(!!credential.revokedAt||new Date(credential.expiresAt).getTime()<=Date.now())} onChange={value=>{if(disabled||!grant.data||grant.error)return;void action.run(t.admin.mailboxGrant,async()=>{await saveCrmMailboxGrant(workspaceId,instanceId,credential.id,{expectedVersion:grant.data?.grant?.version ?? 0,confirmed:true,enabled:value});await grant.refresh();});}}/></AssociationListState>{action.feedback}
  </section>;
}
function MailboxDetails({workspaceId,instanceId,disabled}:{workspaceId:string;instanceId:string;disabled:boolean}) {
  const t=useT().associationPage;
  const policy=useCachedResource(associationPageCacheKey(workspaceId,"mailbox-policy",{instanceId}),()=>getCrmMailboxPolicy(workspaceId,instanceId));
  const credentials=useAssociationPage(workspaceId,"credentials");
  const [editor,setEditor]=useState<{policy:CrmManagedMailboxPolicy|null}|null>(null),[credential,setCredential]=useState<CrmManagedCredential|null>(null);
  return <div className="space-y-4"><p className="break-all text-sm">{t.admin.mailboxId}: {instanceId}</p>
    <AssociationListState {...policy}><div className="space-y-1 text-sm"><p>{t.admin.readVersion}: {policy.data?.policy?.version ?? 0}</p><p>{policy.data?.policy?.providerKey ?? t.admin.unconfigured}</p><p>{policy.data?.policy?.purposeKeys.join(", ")}</p></div>
      <Button type="button" className="min-h-11" variant="outline" disabled={disabled||!!policy.error||!policy.data} onClick={()=>setEditor({policy:policy.data!.policy})}>{t.manage.edit}</Button>
    </AssociationListState>
    {editor?<AssociationMailboxPolicyForm key={`${instanceId}:${editor.policy?.version ?? 0}`} workspaceId={workspaceId} instanceId={instanceId} policy={editor.policy} disabled={disabled||!!policy.error} onSaved={()=>{setEditor(null);void policy.refresh();}}/>:null}
    <h3 className="font-semibold">{t.admin.mailboxGrant}</h3><AssociationListState {...credentials}><div className="max-h-56 overflow-y-auto divide-y divide-border">{credentials.data?.items.map(row=><Button type="button" className="min-h-11 w-full justify-start" key={row.id} variant="ghost" disabled={disabled||!!credentials.error} onClick={()=>setCredential(row)}>{row.label} · {row.prefix}</Button>)}</div>{credentials.data?.items.length===0?<p>{t.manage.empty}</p>:null}</AssociationListState>
    {credential?<AssociationMailboxGrantControl key={`${instanceId}:${credential.id}`} workspaceId={workspaceId} instanceId={instanceId} credential={credentials.data?.items.find(row=>row.id===credential.id) ?? credential} disabled={disabled||!!credentials.error}/>:null}
  </div>;
}
export function AssociationMailboxPanel({workspaceId,disabled}:{workspaceId:string;disabled:boolean}) {
  const t=useT().associationPage,mailboxes=useCachedResource(associationPageCacheKey(workspaceId,"mailboxes"),()=>listCrmMailboxes(workspaceId));
  const [draft,setDraft]=useState(""),[instanceId,setInstanceId]=useState("");
  return <section className="space-y-3"><h3 className="font-semibold">{t.admin.mailboxes}</h3><AssociationListState {...mailboxes}><div className="divide-y divide-border">{mailboxes.data?.map(row=><Button type="button" key={row.id} className="min-h-11 w-full justify-start" variant="ghost" disabled={disabled||!!mailboxes.error} onClick={()=>{setInstanceId(row.id);setDraft(row.id);}}>{row.label} · {row.provider}</Button>)}</div></AssociationListState>
    <form className="flex flex-wrap items-end gap-2" onSubmit={e=>{e.preventDefault();if(!disabled)setInstanceId(draft.trim());}}><AssociationField label={t.admin.mailboxId} value={draft} onChange={setDraft} required pattern="[a-fA-F0-9-]{36}" maxLength={36}/><Button type="submit" className="min-h-11" variant="outline" disabled={disabled}>{t.admin.loadMailbox}</Button></form>
    {instanceId?<MailboxDetails key={instanceId} workspaceId={workspaceId} instanceId={instanceId} disabled={disabled}/>:null}
  </section>;
}
