"use client";

/** One navigation home for the directory and access administration.
 * [COMP:app-web/organization-chart] */
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Building2, Network, ShieldCheck, UsersRound } from 'lucide-react';
import { useT } from '@/lib/i18n/client';
import { useWorkspaceContext } from '@/lib/workspace-context';
import { deploymentCapabilities } from '@/lib/edition';
import { ORGANIZATION_SECTIONS, organizationHref, organizationSection } from '@/lib/organization-navigation';
import { OrganizationChartView } from './organization-chart';
import { TeamsContextSection } from '@/components/settings-modal/sections/context-scopes-section';
import { WorkspaceMembersSection } from '@/components/settings-modal/workspace-sections';
import { WorkspaceAccessView } from '@/components/workspace-access/workspace-access';

export function OrganizationHub() {
  const { workspaceId, me } = useWorkspaceContext();
  const params = useSearchParams();
  const router = useRouter();
  const t = useT().organization;
  const section = organizationSection(params.get('section'));
  const memberId = section === 'people' ? params.get('member') : null;
  const navigation = {
    structure: { label: t.structureTab, summary: t.structureSummary, icon: Network },
    people: { label: t.peopleTab, summary: t.peopleSummary, icon: UsersRound },
    departments: { label: t.departmentsTab, summary: t.departmentsSummary, icon: Building2 },
    access: { label: t.accessTab, summary: t.accessSummary, icon: ShieldCheck },
  };
  return <div className="flex h-full min-h-0 min-w-0 flex-col">
    <header className="shrink-0 border-b border-border px-4 pt-4 md:px-6">
      <div className="mx-auto max-w-7xl">
        <h1 className="min-h-8 pl-10 text-xl font-semibold md:pl-0">{t.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t.hubDescription}</p>
        <nav aria-label={t.title} className="mt-4 grid grid-cols-2 gap-2 pb-4 md:grid-cols-4">
          {ORGANIZATION_SECTIONS.map(item => {
            const destination = navigation[item], Icon = destination.icon, active = section === item;
            return <Link key={item} href={organizationHref(workspaceId, item)} aria-current={active ? 'page' : undefined}
              className={`group min-h-20 rounded-xl border p-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${active ? 'border-primary bg-primary/5 shadow-sm' : 'border-border bg-background hover:border-foreground/25 hover:bg-muted/40'}`}>
              <span className={`flex items-center gap-2 text-sm font-semibold ${active ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground'}`}><Icon className="size-4 shrink-0" />{destination.label}</span>
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{destination.summary}</span>
            </Link>;
          })}
        </nav>
      </div>
    </header>
    <div key={`${workspaceId}:${me.id}:${section}`} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      {section === 'structure' ? <OrganizationChartView /> : section === 'access' ? <WorkspaceAccessView selection={{kind:'requests'}} /> :
        <div className="mx-auto max-w-7xl p-4 md:p-6">
          {section === 'departments' ? <TeamsContextSection renderAccessSettings={id=><WorkspaceAccessView embedded selection={{kind:'department',id}}/>} /> : <div className={memberId?'grid items-start gap-6 lg:grid-cols-[minmax(18rem,0.8fr)_minmax(0,1.2fr)]':''}><WorkspaceMembersSection
              memberTarget={memberId ? { workspaceId, memberId } : undefined}
              clearMember={() => router.push(organizationHref(workspaceId, 'people'))}
              selectMember={id=>router.push(organizationHref(workspaceId,'people',id))}
              managementEnabled={deploymentCapabilities().teammateManagement} />
            {memberId?<WorkspaceAccessView embedded selection={{kind:'person',id:memberId}}/>:null}</div>}
        </div>}
    </div>
  </div>;
}
