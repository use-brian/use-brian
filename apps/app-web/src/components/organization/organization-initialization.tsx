"use client";

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { OrganizationChart } from '@use-brian/shared';
import { useT } from '@/lib/i18n/client';
import type {useOrganizationChange} from './use-organization-change';
import { Button } from '@/components/ui/button';

/** Admin-reviewed direct assignments, never inferred hierarchy. [COMP:app-web/organization-chart] */
export function OrganizationInitialization({chart,close,change}:{chart:OrganizationChart;close:()=>void;change:ReturnType<typeof useOrganizationChange>}) {
  const t=useT().organization;
  const [selection,setSelection]=useState(''),[teamId,setTeamId]=useState('');
  const busy=change.busy;
  const heading=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{heading.current?.focus();heading.current?.scrollIntoView?.({block:'nearest'});},[]);
  const candidates=chart.initialization?.candidates??[];
  const candidate=candidates.find(c=>`${c.kind}:${c.subjectId}`===selection);
  const subject=chart.subjects.find(s=>s.id===candidate?.subjectId&&s.kind===candidate?.kind);
  const team=chart.teams.find(team=>team.id===teamId&&candidate?.teamIds.includes(team.id));
  const unit=chart.units.find(unit=>unit.teamId===teamId);
  const effect=team?(unit?t.initializeUses:t.initializeCreates).replace('{unit}',unit?.name??team.name):'';
  const subjectName=subject?.name||(subject?.kind==='assistant'?t.unnamedAssistant:t.unnamedPerson);
  async function submit(event:FormEvent) {
    event.preventDefault();
    if(!chart.canManage||!candidate||!subject||!team||!chart.initialization||busy)return;
    await change.save({type:'org.initialize.subject',kind:candidate.kind,subjectId:candidate.subjectId,teamId:team.id,
      expectedRevision:chart.revision,expectedPolicyRevision:chart.initialization.policyRevision},`${subjectName}: ${effect} ${t.permissionHint}`);
  }
  if(!chart.canManage||!chart.initialization)return null;
  return <aside aria-label={t.initialize} className="min-w-0 rounded-xl border border-border bg-card p-4 lg:sticky lg:top-4">
    <div className="mb-3 flex items-center justify-between gap-2"><h2 tabIndex={-1} ref={heading} className="break-words font-semibold">{t.initialize}</h2><Button variant="ghost" className="min-h-11" onClick={close}>{t.close}</Button></div>
    <p className="mb-4 text-sm text-muted-foreground">{t.initializeHint}</p>
    <form onSubmit={submit} className="space-y-4">
      <fieldset disabled={busy} className="space-y-2"><legend className="text-sm font-medium">{t.initializeSubject}</legend>
        <div className="max-h-60 space-y-1 overflow-y-auto">{candidates.map(c=>{
          const person=chart.subjects.find(s=>s.kind===c.kind&&s.id===c.subjectId);if(!person)return null;
          const key=`${c.kind}:${c.subjectId}`;
          return <Button key={key} type="button" variant={selection===key?'secondary':'outline'} aria-pressed={selection===key} className="min-h-11 h-auto w-full justify-start whitespace-normal text-left" onClick={()=>{setSelection(key);setTeamId('');}}><span className="min-w-0 break-words">{person.name||(c.kind==='assistant'?t.unnamedAssistant:t.unnamedPerson)} ({c.kind==='assistant'?t.assistant:t.person})</span></Button>;
        })}</div>
      </fieldset>
      {candidate?<fieldset disabled={busy} className="space-y-2"><legend className="text-sm font-medium">{t.initializeDepartment}</legend>
        {chart.teams.filter(team=>candidate.teamIds.includes(team.id)).map(team=><Button key={team.id} type="button" variant={teamId===team.id?'secondary':'outline'} aria-pressed={teamId===team.id} className="min-h-11 h-auto w-full justify-start whitespace-normal text-left" onClick={()=>setTeamId(team.id)}><span className="min-w-0 break-words">{team.name}</span></Button>)}
      </fieldset>:null}
      {team?<p className="rounded-lg bg-muted p-3 text-sm">{effect}</p>:null}
      <p className="text-xs text-muted-foreground">{t.permissionHint}</p>
      <Button type="submit" className="min-h-11 w-full" disabled={busy||!team}>{busy?t.saving:t.save}</Button>
    </form>
  </aside>;
}
