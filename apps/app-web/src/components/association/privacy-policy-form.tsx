"use client";

/** Complete owner-approved CRM privacy settings, with no inferred periods. [COMP:app-web/association] */
import {useState} from "react";
import {useT} from "@/lib/i18n/client";
import {saveCrmFullPrivacyPolicy,type CrmPrivacyPolicySnapshot,type CrmPrivacySettings,type CrmRetentionSettings} from "@/lib/api/crm-administration";
import {Button} from "@/components/ui/button";
import {AssociationField,AssociationToggle,useAssociationAction} from "./operator-controls";

const cutoffKeys=["resolvedSubmissionsSeconds","importReceiptsSeconds","deliveryReceiptsSeconds","auditSeconds","financialRecordsSeconds"] as const;
const holdDomains=["contact","submission","order","file"] as const;
const holdLabels={contact:"holdContact",submission:"holdSubmission",order:"holdOrder",file:"holdFile"} as const;
const seconds=(value:string)=>value.trim()?Number(value):null;
const ids=(value:string)=>value.split("\n").map(v=>v.trim()).filter(Boolean);
export function AssociationPrivacyPolicyForm({workspaceId,snapshot,disabled,onSaved}:{workspaceId:string;snapshot:CrmPrivacyPolicySnapshot;disabled:boolean;onSaved:()=>void}) {
  const t=useT().associationPage,p=t.privacy,action=useAssociationAction(workspaceId),policy=snapshot.policy;
  const [intake,setIntake]=useState(String(policy.intakeReplay?.retentionSeconds ?? "")),[suppression,setSuppression]=useState(String(policy.addressSuppression?.retentionSeconds ?? ""));
  const [source,setSource]=useState(String(policy.importSourceErasure?.receiptRetentionSeconds ?? "")),[sourceHolds,setSourceHolds]=useState(policy.importSourceErasure?.heldSourceIds.join("\n") ?? "");
  const [retention,setRetention]=useState(!!policy.retention),[scheduled,setScheduled]=useState(policy.retention?.scheduled ?? false),[interval,setInterval]=useState(String(policy.retention?.intervalSeconds ?? ""));
  const [cutoffs,setCutoffs]=useState(()=>Object.fromEntries(cutoffKeys.map(key=>[key,String(policy.retention?.[key] ?? "")])) as Record<typeof cutoffKeys[number],string>);
  const [openAfter,setOpenAfter]=useState(String(policy.retention?.openSubmissions?.afterSeconds ?? "")),[fields,setFields]=useState<Array<"subject"|"message"|"metadata"|"notes">>(policy.retention?.openSubmissions?.fields ?? []);
  const [holds,setHolds]=useState(()=>Object.fromEntries(holdDomains.map(domain=>[domain,policy.retention?.holds.filter(h=>h.domain===domain).map(h=>h.id).join("\n") ?? ""])) as Record<typeof holdDomains[number],string>);
  const period=(label:string,value:string,onChange:(value:string)=>void,required=false,min=1,max=2147483647)=><AssociationField label={label} type="number" min={min} max={max} step={1} value={value} onChange={onChange} required={required}/>;
  return <form className="space-y-4 rounded-xl border border-border p-4" onSubmit={e=>{e.preventDefault();if(disabled)return;void action.run(t.manage.save,async()=>{
    const settings:CrmPrivacySettings={intakeReplay:intake.trim()?{retentionSeconds:Number(intake)}:null,addressSuppression:suppression.trim()?{retentionSeconds:Number(suppression)}:null,importSourceErasure:source.trim()?{receiptRetentionSeconds:Number(source),heldSourceIds:ids(sourceHolds)}:null,
      retention:retention?{scheduled,intervalSeconds:Number(interval),...Object.fromEntries(cutoffKeys.map(key=>[key,seconds(cutoffs[key])])),openSubmissions:openAfter.trim()?{afterSeconds:Number(openAfter),fields}:null,holds:holdDomains.flatMap(domain=>ids(holds[domain]).map(id=>({domain,id})))} as CrmRetentionSettings:null};
    await saveCrmFullPrivacyPolicy(workspaceId,{...settings,expectedVersion:snapshot.version,confirmed:true});onSaved();
  });}}>
    <p className="text-sm">{t.admin.readVersion}: {snapshot.version}</p><p className="text-sm text-muted-foreground">{p.policyHelp}</p>
    <fieldset disabled={disabled||action.pending} className="space-y-4"><div className="grid gap-3 md:grid-cols-2">{period(p.intakeReplay,intake,setIntake)}{period(p.addressSuppression,suppression,setSuppression)}{period(p.sourceRetention,source,setSource)}<AssociationField label={p.heldSources} multiline value={sourceHolds} onChange={setSourceHolds}/></div>
      <AssociationToggle label={p.retentionEnabled} checked={retention} onChange={setRetention} disabled={disabled||action.pending}/>
      {retention?<div className="space-y-3 border-l-2 border-border pl-3"><AssociationToggle label={p.scheduled} checked={scheduled} onChange={setScheduled} disabled={disabled||action.pending}/>
        {period(p.interval,interval,setInterval,true,60,86400)}<div className="grid gap-3 md:grid-cols-2">{cutoffKeys.map(key=><div key={key}>{period(p[key],cutoffs[key],value=>setCutoffs(old=>({...old,[key]:value})))}</div>)}</div>
        {period(p.openAfter,openAfter,setOpenAfter)}<h4 className="text-sm font-medium">{p.redactFields}</h4><div className="flex flex-wrap gap-3">{(["subject","message","metadata","notes"] as const).map(field=><AssociationToggle key={field} label={p[field]} checked={fields.includes(field)} disabled={disabled||action.pending} onChange={checked=>setFields(old=>checked?[...old,field]:old.filter(key=>key!==field))}/>)}</div>
        <div className="grid gap-3 md:grid-cols-2">{holdDomains.map(domain=><AssociationField key={domain} label={p[holdLabels[domain]]} multiline value={holds[domain]} onChange={value=>setHolds(old=>({...old,[domain]:value}))}/>)}</div>
      </div>:null}
    </fieldset>{action.feedback}<Button type="submit" className="max-sm:min-h-11" disabled={disabled||action.pending}>{t.manage.save}</Button>
  </form>;
}
