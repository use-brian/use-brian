/** Canonical organization destinations, including legacy Settings entry points.
 * [COMP:app-web/organization-chart] */
import type { SettingsMemberTarget, SettingsSection } from './workspace-settings-events';

const ORGANIZATION_SECTIONS = ['structure', 'people', 'departments', 'access'] as const;
export type OrganizationSection = typeof ORGANIZATION_SECTIONS[number];

export function organizationSection(value: string | null): OrganizationSection {
  return ORGANIZATION_SECTIONS.find(section => section === value) ?? 'structure';
}

export function organizationHref(workspaceId: string, section: OrganizationSection = 'structure', memberId?: string): string {
  const query = new URLSearchParams();
  if (section !== 'structure') query.set('section', section);
  if (section === 'people' && memberId) query.set('member', memberId);
  return `/w/${encodeURIComponent(workspaceId)}/organization${query.size ? `?${query}` : ''}`;
}

export function organizationSettingsHref(workspaceId: string, section: SettingsSection, target?: SettingsMemberTarget): string | null {
  const destination = section === 'ws-organization' ? 'structure'
    : section === 'ws-members' ? 'people'
    : section === 'ws-teams' ? 'departments'
    : section === 'ws-access' ? 'access' : null;
  if (!destination) return null;
  // A stale cross-workspace person shortcut never selects someone in this workspace.
  if (target && section === 'ws-members' && target.workspaceId !== workspaceId) return organizationHref(workspaceId);
  return organizationHref(workspaceId, destination, target?.memberId);
}

/** Ready Simple suppresses routine requests, never administrator recovery. */
export function visibleOrganizationSections(mode?:{mode:string;setupState:string;canAdminister:boolean}) {
 return ORGANIZATION_SECTIONS.filter(section=>!(mode?.mode==='simple'&&mode.setupState==='ready'&&!mode.canAdminister&&(section==='departments'||section==='access')));
}
