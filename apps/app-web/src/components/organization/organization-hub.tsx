"use client";

/** One navigation home for the directory and access administration. Section
 * navigation lives in the sidebar panel and the top bar, never in the page.
 * [COMP:app-web/organization-chart] */
import {useWorkspaceAccessMode,WorkspaceModeSummary} from '@/components/context/mode-aware-context';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useT } from '@/lib/i18n/client';
import { useWorkspaceContext } from '@/lib/workspace-context';
import { deploymentCapabilities } from '@/lib/edition';
import { organizationHref, organizationSection } from '@/lib/organization-navigation';
import { OrganizationChartView } from './organization-chart';
import { OrganizationTopbar } from './organization-topbar';
import { OrganizationTopbarSlotProvider } from './organization-chrome';
import { TeamsContextSection } from '@/components/settings-modal/sections/context-scopes-section';
import { WorkspaceMembersSection } from '@/components/settings-modal/workspace-sections';
import { WorkspaceAccessView } from '@/components/workspace-access/workspace-access';

export function OrganizationHub() {
  const { workspaceId, me } = useWorkspaceContext();
  const mode=useWorkspaceAccessMode();
  const params = useSearchParams();
  const router = useRouter();
  const t = useT().organization;
  const section = organizationSection(params.get('section'));
  const memberId = section === 'people' ? params.get('member') : null;
  const [actionSlot, setActionSlot] = useState<HTMLElement | null>(null);
  return <div className="flex h-full min-h-0 min-w-0 flex-col">
    <OrganizationTopbar workspaceId={workspaceId} section={section} slotRef={setActionSlot} />
    <h1 className="sr-only">{t.title}</h1>
    <OrganizationTopbarSlotProvider value={actionSlot}>
      {/* pb-28 clears the floating "Ask anything" chat dock, as in Studio. */}
      <div key={`${workspaceId}:${me.id}:${section}`} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full min-w-0 max-w-7xl px-4 pb-28 pt-5 md:px-8">
          {mode.readySimple&&!mode.data?.canAdminister&&(section==='access'||section==='departments')?<WorkspaceModeSummary/>:section === 'structure' ? <OrganizationChartView /> : section === 'access' ? <WorkspaceAccessView selection={{kind:'requests'}} /> :
            section === 'departments' ? <TeamsContextSection renderAccessSettings={id=><WorkspaceAccessView embedded selection={{kind:'department',id}}/>} /> :
            <div className={memberId?'grid items-start gap-6 lg:grid-cols-[minmax(18rem,0.8fr)_minmax(0,1.2fr)]':''}><WorkspaceMembersSection
                memberTarget={memberId ? { workspaceId, memberId } : undefined}
                clearMember={() => router.push(organizationHref(workspaceId, 'people'))}
                selectMember={id=>router.push(organizationHref(workspaceId,'people',id))}
                managementEnabled={deploymentCapabilities().teammateManagement} />
              {memberId?<WorkspaceAccessView embedded selection={{kind:'person',id:memberId}}/>:null}</div>}
        </div>
      </div>
    </OrganizationTopbarSlotProvider>
  </div>;
}
