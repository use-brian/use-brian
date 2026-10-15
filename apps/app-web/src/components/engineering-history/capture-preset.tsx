"use client";
/** Native admin preset, without a second routing registry. [COMP:app-web/engineering-history] */
import {useRef,useState} from "react";
import {useT} from "@/lib/i18n/client";
import {confirmDialog} from "@/components/ui/confirm-dialog";
import {discardPendingEngineeringHistory} from "@/lib/api/engineering-history";
import {Button} from "@/components/ui/button";
import {ContextScopePicker} from "@/components/context/context-scope-picker";
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from "@/components/ui/select";
import type {ContextProject,ContextTeam} from "@/lib/api/context-scopes";
import {addCaptureRule,createCaptureProfile} from "@/lib/api/programmatic-capture";
import {BRAIN_MCP_URL} from "@/lib/api/brain-keys";
import {invalidateSurfaceCache} from "@/lib/surface-cache";
export function CapturePreset({workspaceId,teams,projects,onCreated,onError}:{workspaceId:string;teams:ContextTeam[];projects:ContextProject[];onCreated:()=>Promise<void>;onError:(error:string|null)=>void}){
 const t=useT().engineeringHistory;
 const [name,setName]=useState(""),[team,setTeam]=useState<string|null>(null),[project,setProject]=useState<string|null>(null),[busy,setBusy]=useState(false);
 async function create(){if(!team||!name.trim())return;setBusy(true);onError(null);try{
  const profile=await createCaptureProfile(workspaceId,{name:name.trim(),partitionBy:"session",processingMode:"archive_only",enabled:true,destination:{kind:"department",departmentId:team,...(project?{projectId:project}:{})}});
  await addCaptureRule(workspaceId,profile.id,{ruleOrder:0,filterType:"role_match",filterParams:{values:["user","assistant"]},routingMode:"realtime",routingSchedule:null,routingTimezone:"UTC",episodeSensitivity:"internal",scopeBindingMode:"explicit",compartments:[`team:${team}`],projectIds:project?[project]:[]});
  invalidateSurfaceCache(`engineering-history:${workspaceId}`);setName("");await onCreated();
 }catch{onError(t.unavailable);await onCreated()}finally{setBusy(false)}}
 return <section className="rounded-xl border border-border bg-card p-4 flex flex-col gap-3">
  <h2 className="font-semibold">{t.preset}</h2><p className="text-sm text-muted-foreground">{t.presetHint}</p>
  <label className="grid gap-1 text-sm">{t.name}<input aria-label={t.name} value={name} maxLength={120} onChange={e=>setName(e.target.value)} className="min-h-8 max-sm:min-h-11 rounded-lg border border-border bg-background px-3 text-base"/></label>
  <ContextScopePicker teams={teams} projects={projects} teamId={team} projectId={project} onTeamChange={setTeam} onProjectChange={setProject} disabled={busy}/>
  <p className="text-sm text-muted-foreground">{team?`${t.audience}: ${teams.find(x=>x.id===team)?.name??""}${project?` / ${projects.find(x=>x.id===project)?.name??""}`:""}`:t.requiredAudience}</p>
  <Button className="min-h-8 max-sm:min-h-11 self-start" disabled={busy||!team||!name.trim()} onClick={()=>void create()}>{busy?t.busy:t.create}</Button><p className="text-sm text-muted-foreground">{t.scopeHint}</p>
 </section>
}
const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
export function CaptureSetup(){const t=useT().engineeringHistory;const [provider,setProvider]=useState("codex"),[project,setProject]=useState(""),[env,setEnv]=useState("BRAIN_CAPTURE_KEY");
 return <details className="rounded-xl border border-border bg-card p-4"><summary className="min-h-8 max-sm:min-h-11 cursor-pointer font-medium">{t.setup}</summary><div className="grid gap-3 pt-2">
 <p className="text-sm text-muted-foreground">{t.setupHint}</p>
 <Select value={provider} items={{codex:t.providerCodex,"claude-code":t.providerClaude}} onValueChange={v=>v&&setProvider(v)}><SelectTrigger className="min-h-8 max-sm:min-h-11" aria-label={t.provider}><SelectValue/></SelectTrigger><SelectContent><SelectItem value="codex">{t.providerCodex}</SelectItem><SelectItem value="claude-code">{t.providerClaude}</SelectItem></SelectContent></Select>
 <label className="grid gap-1 text-sm">{t.projectPath}<input value={project} onChange={e=>setProject(e.target.value)} className="min-h-8 max-sm:min-h-11 rounded-lg border border-border bg-background px-3 text-base"/></label>
 <label className="grid gap-1 text-sm">{t.keyReference}<input value={env} onChange={e=>setEnv(e.target.value)} className="min-h-8 max-sm:min-h-11 rounded-lg border border-border bg-background px-3 text-base"/></label>
 {project.startsWith("/")&&/^[A-Z][A-Z0-9_]*$/.test(env)&&<div><p className="text-sm">{t.inspectSetup}</p><pre className="mt-2 whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">{`brian-capture setup --provider ${provider} --endpoint ${quote(BRAIN_MCP_URL)} --credential-env ${env} --project ${quote(project)}`}</pre></div>}
 <p className="text-sm font-medium">{t.localHealth}</p><p className="text-sm text-muted-foreground">{t.localHealthHint}</p><p className="text-sm font-medium">{t.coverage}</p><p className="text-sm text-muted-foreground">{t.coverageHint}</p>
 </div></details>
}

/** A content-free self-recovery operation, separate from admin configuration. */
export function PendingCaptureRecovery({workspaceId}:{workspaceId:string}){
 const t=useT().engineeringHistory,[busy,setBusy]=useState(false),[state,setState]=useState<"done"|"error"|null>(null),nonce=useRef<string|null>(null);
 async function discard(){if(!await confirmDialog({title:t.discardPending,description:t.discardPendingConfirm,confirmLabel:t.discardPending,cancelLabel:t.cancel,variant:"destructive"}))return;
  setBusy(true);setState(null);nonce.current??=crypto.randomUUID();try{await discardPendingEngineeringHistory(workspaceId,nonce.current);nonce.current=null;invalidateSurfaceCache(`engineering-history:${workspaceId}`);setState("done")}catch{setState("error")}finally{setBusy(false)}
 }
 return <details className="rounded-xl border border-border bg-card p-4"><summary className="min-h-8 max-sm:min-h-11 cursor-pointer font-medium">{t.pendingRecovery}</summary><p className="mt-2 text-sm text-muted-foreground">{t.pendingReview}</p><Button className="mt-3 max-sm:min-h-11" variant="destructive" disabled={busy} onClick={()=>void discard()}>{t.discardPending}</Button>{state&&<p role="status" className="mt-2 text-sm">{state==="done"?t.pendingDiscarded:t.unavailable}</p>}</details>
}
