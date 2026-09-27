"use client";

/** One navigation home for the directory and access administration.
 * [COMP:app-web/organization-chart] */
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
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
  const labels = { structure: t.structureTab, people: t.peopleTab, departments: t.departmentsTab, access: t.accessTab };
  return <div className="flex h-full min-h-0 min-w-0 flex-col">
    <header className="shrink-0 border-b border-border px-4 pt-4 md:px-6">
      <h1 className="min-h-8 pl-10 text-xl font-semibold md:pl-0">{t.title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t.hubDescription}</p>
      <nav aria-label={t.title} className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
        {ORGANIZATION_SECTIONS.map(item => <Link key={item} href={organizationHref(workspaceId, item)}
          aria-current={section === item ? 'page' : undefined}
          className={`flex min-h-11 items-center border-b-2 px-1 text-sm font-medium focus-visible:outline focus-visible:outline-ring ${section === item ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
          {labels[item]}
        </Link>)}
      </nav>
    </header>
    <div key={`${workspaceId}:${me.id}:${section}`} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      {section === 'structure' ? <OrganizationChartView /> : section === 'access' ? <WorkspaceAccessView /> :
        <div className="mx-auto max-w-6xl p-4 md:p-6">
          {section === 'departments' ? <TeamsContextSection /> : <WorkspaceMembersSection
            memberTarget={memberId ? { workspaceId, memberId } : undefined}
            clearMember={() => router.push(organizationHref(workspaceId, 'people'))}
            managementEnabled={deploymentCapabilities().teammateManagement} />}
        </div>}
    </div>
  </div>;
}
