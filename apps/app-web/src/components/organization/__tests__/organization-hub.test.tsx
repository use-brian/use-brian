// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { OrganizationHub } from "../organization-hub";
import type { SettingsMemberTarget } from '@/lib/workspace-settings-events';
import { resetSurfaceCache } from '@/lib/surface-cache';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const edition = vi.hoisted(() => ({ teammateManagement: true }));

vi.mock("@/lib/edition", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/edition")>(),
  isOssEdition: () => !edition.teammateManagement,
  deploymentCapabilities: () => ({ teammateManagement: edition.teammateManagement, billing: edition.teammateManagement }),
}));
vi.mock("@/lib/workspace-context", () => ({
  useWorkspaceContext: () => ({ workspaceId: "workspace-1", me: { id: "user-1" } }),
}));
vi.mock("@/lib/user", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/user")>(),
  getUserInfo: () => ({ id: "user-1" }),
}));
vi.mock("@/lib/auth-fetch", () => ({
  authFetch: vi.fn(async (url: string) => ({
    ok: true,
    json: async () => url.endsWith("/invitations")
      ? { invitations: [] }
      : { id: "workspace-1", name: "Example workspace", role: "owner", members: [
        {userId:'user-1',userName:'Riley',role:'owner',email:'riley@example.com'},
        {userId:'user-2',userName:'Casey',role:'member',email:'casey@example.com'},
      ] },
  })),
}));
const navigation = vi.hoisted(() => ({ query: '', push: vi.fn() }));
const sidebar = vi.hoisted(() => ({ collapsed: false }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(navigation.query), useRouter: () => ({ push: navigation.push, back: vi.fn(), forward: vi.fn() }), usePathname: () => '/w/workspace-1/organization' }));
vi.mock('@/components/doc/doc-sidebar-data', () => ({ useSidebarData: () => ({ sidebarCollapsed: sidebar.collapsed, setSidebarCollapsed: vi.fn() }) }));
vi.mock('../organization-chart', async () => {
  const { OrganizationTopbarActions } = await import('../organization-chrome');
  return { OrganizationChartView: () => <><OrganizationTopbarActions><button type="button">Structure action</button></OrganizationTopbarActions><h2>Structure fixture</h2></> };
});
vi.mock('@/components/workspace-access/workspace-access', () => ({ WorkspaceAccessView: ({selection,embedded}:{selection:{kind:string;id?:string};embedded?:boolean}) => <div data-access-kind={selection.kind} data-access-id={selection.id} data-embedded={embedded?'true':'false'}>{selection.kind==='requests'?'Access fixture':'Scoped access fixture'}</div> }));
vi.mock('@/components/settings-modal/sections/context-scopes-section', () => ({ TeamsContextSection: ({renderAccessSettings}:{renderAccessSettings:(id:string)=>React.ReactNode}) => <><h2>Departments fixture</h2>{renderAccessSettings('department-fixture')}</> }));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => { sidebar.collapsed = false; edition.teammateManagement = true; resetSurfaceCache(); navigation.query = 'section=people'; navigation.push.mockReset(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render(memberId?: string) {
  navigation.query = `section=people${memberId ? `&member=${memberId}` : ''}`;
  await redraw();
}
async function redraw() { await act(async () => root.render(<I18nProvider locale="en" dict={en}><OrganizationHub /></I18nProvider>)); }
describe('[COMP:app-web/organization-chart] unified organization home', () => {
  it.each(['structure', 'people', 'departments', 'access'] as const)('mounts only the active %s section under the shared top bar', async section => {
    navigation.query = `section=${section}`; await redraw();
    const labels = { structure: en.organization.structureTab, people: en.organization.peopleTab, departments: en.organization.departmentsTab, access: en.organization.accessTab };
    // The phone section menu names the active section; the sidebar panel is the desktop switcher.
    expect(host.querySelector('[data-organization-section-menu]')?.textContent).toBe(labels[section]);
    expect(host.querySelector('[data-organization-switcher]')).toBeNull();
    const summaries = { structure: en.organization.structureSummary, people: en.organization.peopleSummary, departments: en.organization.departmentsSummary, access: en.organization.accessSummary };
    // The top bar names only the active section; the page repeats no navigation cards.
    expect(host.querySelector('[data-organization-section-title]')?.textContent).toContain(summaries[section]);
    for (const [key, summary] of Object.entries(summaries)) expect(host.textContent?.includes(summary)).toBe(key === section);
    expect(host.querySelector('h1')?.textContent).toBe(en.organization.title);
    expect(host.textContent?.includes('Structure fixture')).toBe(section === 'structure');
    expect(host.textContent?.includes('Access fixture')).toBe(section === 'access');
    expect(host.textContent?.includes('Departments fixture')).toBe(section === 'departments');
    expect(host.textContent?.includes('Casey')).toBe(section === 'people');
  });
  it('opens a roster person and embeds only their scoped access controls',async()=>{
    await render();
    const person=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='Casey')!;
    expect(person).toBeDefined();await act(async()=>person.click());
    expect(navigation.push).toHaveBeenCalledWith('/w/workspace-1/organization?section=people&member=user-2');
    await render('user-2');expect(host.querySelector('[data-access-kind="person"]')?.getAttribute('data-access-id')).toBe('user-2');
    expect(host.querySelector('[data-access-kind="person"]')?.getAttribute('data-embedded')).toBe('true');
    await render('user-1');expect(host.querySelector('[data-access-kind="person"]')?.getAttribute('data-access-id')).toBe('user-1');
    await render();expect(host.querySelector('[data-access-kind]')).toBeNull();
  });
  it('embeds selected department controls and keeps Access on requests',async()=>{
    navigation.query='section=departments';await redraw();expect(host.querySelector('[data-access-kind="department"]')?.getAttribute('data-access-id')).toBe('department-fixture');
    expect(host.querySelector('[data-access-kind="department"]')?.getAttribute('data-embedded')).toBe('true');
    navigation.query='section=access';await redraw();expect(host.querySelector('[data-access-kind="requests"]')).not.toBeNull();expect(host.querySelector('[data-access-kind="requests"]')?.getAttribute('data-embedded')).toBe('false');expect(host.querySelector('[data-access-kind="department"]')).toBeNull();
  });
  it('swaps the section title for a compact menu beside a collapsed desktop sidebar', async () => {
    navigation.query = 'section=departments'; sidebar.collapsed = true; await redraw();
    const switcher = host.querySelector('[data-organization-section-menu]')!;
    expect(switcher.textContent).toContain(en.organization.departmentsTab);
    expect(switcher.className).not.toContain('md:hidden');
    expect(host.querySelector('[data-organization-section-title]')).toBeNull();
    sidebar.collapsed = false; await redraw();
    expect(host.querySelector('[data-organization-switcher]')).toBeNull();
    expect(host.querySelector('[data-organization-section-title]')?.textContent).toContain(en.organization.departmentsSummary);
  });
  it('renders the active section actions in the top bar slot', async () => {
    navigation.query = 'section=structure'; await redraw();
    const action = [...host.querySelectorAll('button')].find(b => b.textContent === 'Structure action');
    expect(action?.closest('[data-organization-actions]')).not.toBeNull();
    navigation.query = 'section=access'; await redraw();
    expect(host.querySelector('[data-organization-actions]')?.textContent).toBe('');
  });
  it('falls back to Structure for an unknown section', async () => {
    navigation.query = 'section=unknown'; await redraw(); expect(host.textContent).toContain('Structure fixture');
  });
  it('opens the exact selected person and returns to the full roster', async () => {
    await render('user-2'); expect(host.textContent).toContain('Casey'); expect(host.textContent).not.toContain('Riley');
    expect(host.querySelector('textarea')).toBeNull();
    const all = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === en.organization.showAllMembers)!;
    await act(async () => all.click()); expect(navigation.push).toHaveBeenCalledWith('/w/workspace-1/organization?section=people');
    await render(); expect(host.textContent).toContain('Riley'); expect(host.querySelector('textarea')).not.toBeNull();
  });
  it('keeps read-only people available without invitation or role controls', async () => {
    edition.teammateManagement = false; await render('user-2');
    expect(host.textContent).toContain('Casey'); expect(host.textContent).not.toContain('Riley'); expect(host.querySelector('textarea')).toBeNull();
    await render(); expect(host.textContent).toContain('Riley'); expect(host.querySelector('textarea')).toBeNull();
  });
  it('never substitutes another person for an unavailable target', async () => {
    await render('missing'); expect(host.textContent).toContain(en.organization.memberUnavailable);
    expect(host.textContent).not.toContain('Casey'); expect(host.textContent).not.toContain('Riley');
  });
  it('updates person selection when the URL changes', async () => {
    await render('user-2'); expect(host.textContent).toContain('Casey');
    await render('user-1'); expect(host.textContent).toContain('Riley'); expect(host.textContent).not.toContain('Casey');
  });
});
