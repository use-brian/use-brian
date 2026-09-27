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
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(navigation.query), useRouter: () => ({ push: navigation.push }) }));
vi.mock('../organization-chart', () => ({ OrganizationChartView: () => <h2>Structure fixture</h2> }));
vi.mock('@/components/workspace-access/workspace-access', () => ({ WorkspaceAccessView: () => <h2>Access fixture</h2> }));
vi.mock('@/components/settings-modal/sections/context-scopes-section', () => ({ TeamsContextSection: () => <h2>Departments fixture</h2> }));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => { edition.teammateManagement = true; resetSurfaceCache(); navigation.query = 'section=people'; navigation.push.mockReset(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render(memberId?: string) {
  navigation.query = `section=people${memberId ? `&member=${memberId}` : ''}`;
  await redraw();
}
async function redraw() { await act(async () => root.render(<I18nProvider locale="en" dict={en}><OrganizationHub /></I18nProvider>)); }
describe('[COMP:app-web/organization-chart] unified organization home', () => {
  it.each(['structure', 'people', 'departments', 'access'])('mounts only the active %s section and exposes canonical navigation', async section => {
    navigation.query = `section=${section}`; await redraw();
    expect(host.querySelector('nav [aria-current="page"]')?.getAttribute('href')).toBe(`/w/workspace-1/organization${section === 'structure' ? '' : `?section=${section}`}`);
    expect(host.querySelectorAll('nav a')).toHaveLength(4);
    expect(host.textContent?.includes('Structure fixture')).toBe(section === 'structure');
    expect(host.textContent?.includes('Access fixture')).toBe(section === 'access');
    expect(host.textContent?.includes('Departments fixture')).toBe(section === 'departments');
    expect(host.textContent?.includes('Casey')).toBe(section === 'people');
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
