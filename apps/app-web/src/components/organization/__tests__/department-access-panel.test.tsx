// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DepartmentAccessPanel, HomeDepartmentControls } from '../department-access-panel';
import { invalidateSurfaceCache, resetSurfaceCache } from '@/lib/surface-cache';
import { protectProjection } from '@/lib/use-protected-projection';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
import { ja } from '@/lib/i18n/dictionaries/ja';
import { zh } from '@/lib/i18n/dictionaries/zh';
import { zhCN } from '@/lib/i18n/dictionaries/zh-cn';
import { WORKSPACE_IDENTITY_REFRESH_EVENT } from '@/lib/workspace-identity-events';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const W = 'workspace-fixture', D = 'department-fixture';
const mocks = vi.hoisted(() => ({
  viewer: { workspaceId: 'workspace-fixture', role: 'owner', me: { id: 'owner-fixture' } },
  departments: vi.fn(), edges: vi.fn(), setEdge: vi.fn(), removeEdge: vi.fn(), addOwner: vi.fn(), removeOwner: vi.fn(),
  breakGlass: vi.fn(), setHome: vi.fn(), confirm: vi.fn(), prompt: vi.fn(), readDirectory: vi.fn(),
}));
vi.mock('@/lib/workspace-context', () => ({ useWorkspaceContext: () => mocks.viewer }));
// The real directory projection and hook; only the network read is faked.
vi.mock('@/lib/user', async (original) => ({ ...await original<typeof import('@/lib/user')>(), getUserInfo: () => ({ id: mocks.viewer.me.id }) }));
vi.mock('@/lib/api/mentions', async (original) => ({ ...await original<typeof import('@/lib/api/mentions')>(), readWorkspaceMemberDirectory: mocks.readDirectory, listWorkspaceMembers: async () => [] }));
vi.mock('@/lib/api/studio', () => ({ listAssistants: async () => [{ id: 'assistant-fixture', name: 'Ops' }] }));
vi.mock('@/components/ui/confirm-dialog', () => ({ confirmDialog: mocks.confirm }));
vi.mock('@/components/ui/prompt-dialog', () => ({ promptDialog: mocks.prompt }));
vi.mock('@/lib/api/departments', () => ({
  DEPARTMENTS_CHANGED_EVENT: 'brian:departments-changed',
  DepartmentRequestError: class extends Error { constructor(readonly code: string) { super(code); } },
  fetchDepartments: mocks.departments, fetchDepartmentEdges: mocks.edges, setDepartmentEdge: mocks.setEdge,
  removeDepartmentEdge: mocks.removeEdge, addDepartmentOwner: mocks.addOwner, removeDepartmentOwner: mocks.removeOwner,
  breakGlassDepartment: mocks.breakGlass, setHomeDepartment: mocks.setHome,
}));

let root: Root, host: HTMLDivElement;
const member = (userId: string, name: string) => ({ memberId: `m-${userId}`, userId, name, email: null, avatarUrl: null, role: 'member' as const, canDraft: false });
const directory = () => protectProjection({ workspaceId: W, viewerId: mocks.viewer.me.id, validForMs: 30_000,
  members: [member('owner-fixture', 'Ava Example'), member('member-fixture', 'Maya Example'), member('new-fixture', 'Noor Example')] }, performance.now());
const entry = (over: object = {}) => ({ departmentId: D, name: 'Finance', status: 'active', revision: 5, myClearance: 'confidential', isOwner: true, ownerIds: ['owner-fixture'], ...over });
async function render(node: React.ReactNode) {
  await act(async () => { root.render(<I18nProvider locale="en" dict={en}>{node}</I18nProvider>); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('button')].map(b => b.textContent ?? '');
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const t = en.departmentAccess;
async function openActions(name: string) {
  const trigger = host.querySelector<HTMLButtonElement>(`[aria-label="${t.actionsLabel.replace('{name}', name)}"]`);
  expect(trigger, `actions for ${name}`).not.toBeNull();
  await act(async () => { trigger!.click(); });
  await flush();
}
async function chooseItem(text: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.trim() === text);
  expect(item, `menu item ${text}`).toBeDefined();
  await act(async () => { item!.click(); });
  await flush();
}
async function setDate(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  resetSurfaceCache();
  mocks.viewer.me.id = 'owner-fixture';
  mocks.viewer.role = 'owner';
  for (const m of [mocks.departments, mocks.edges, mocks.setEdge, mocks.removeEdge, mocks.addOwner, mocks.removeOwner, mocks.breakGlass, mocks.setHome, mocks.confirm, mocks.prompt, mocks.readDirectory]) m.mockReset();
  mocks.readDirectory.mockImplementation(async () => directory());
  mocks.departments.mockResolvedValue({ departments: [entry()], homes: [{ principal: { kind: 'user', id: 'owner-fixture' }, departmentId: null }] });
  mocks.edges.mockResolvedValue({ edges: [
    { departmentId: D, principal: { kind: 'user', id: 'owner-fixture' }, clearance: 'confidential', expiresAt: null, origin: 'owner' },
    { departmentId: D, principal: { kind: 'user', id: 'member-fixture' }, clearance: 'internal', expiresAt: null, origin: 'migrated' },
    { departmentId: D, principal: { kind: 'assistant', id: 'assistant-fixture' }, clearance: 'confidential', expiresAt: null, origin: 'primary' },
  ] });
  mocks.setEdge.mockResolvedValue({ revision: 6 });
  mocks.removeEdge.mockResolvedValue({ revision: 6 });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('[COMP:app-web/department-access] Organization > Departments: who reads a department and home departments', () => {
  it('groups people and assistants, with clearance, owner, carried-over and every-department markers', async () => {
    await render(<DepartmentAccessPanel departmentId={D} />);
    expect(host.textContent).toContain(t.people);
    expect(host.textContent).toContain(t.assistants);
    expect(host.textContent).toContain('Maya Example');
    expect(host.textContent).toContain(t.carriedOver);
    expect(host.textContent).toContain(t.owner);
    expect(host.textContent).toContain(t.everyDepartment);
    expect(host.querySelector(`[aria-label="${t.clearanceLabel.replace('{name}', 'Maya Example')}"]`)).not.toBeNull();
    // The primary assistant's access is fixed: no clearance control and no actions.
    expect(host.querySelector(`[aria-label="${t.clearanceLabel.replace('{name}', 'Ops')}"]`)).toBeNull();
    expect(host.querySelector(`[aria-label="${t.actionsLabel.replace('{name}', 'Ops')}"]`)).toBeNull();
    await openActions('Maya Example');
    expect([...document.querySelectorAll('[role="menuitem"]')].map(node => node.textContent?.trim())).toEqual([t.setEndDate, t.makeOwner, t.remove]);
  });

  it('keeps member names when the directory is invalidated while its first read is in flight', async () => {
    // The workspace event stream's catch-up (BRAIN_REFRESH / WORKSPACE_IDENTITY_REFRESH)
    // drops the directory key during page load. A read made once on mount kept that
    // empty answer for good: names fell back to "Person" and Add offered no people.
    let finishFirst!: (value: ReturnType<typeof directory>) => void;
    mocks.readDirectory.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }));
    await render(<DepartmentAccessPanel departmentId={D} />);
    await act(async () => invalidateSurfaceCache(`workspace-member-directory:${W}:`));
    await act(async () => finishFirst(directory()));
    await flush();
    expect(mocks.readDirectory).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('Maya Example');
    expect(host.querySelector(`[aria-label="${t.clearanceLabel.replace('{name}', 'Maya Example')}"]`)).not.toBeNull();
  });
  it('keeps adding visible above the roster with guidance when nobody is available', async () => {
    mocks.readDirectory.mockImplementation(async () => {
      const data = directory();
      return { ...data, members: data.members.filter(person => person.userId !== 'new-fixture') };
    });
    await render(<DepartmentAccessPanel departmentId={D} />);
    expect(host.textContent).toContain(t.addTitle);
    expect(host.textContent).toContain(t.addHelp);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(t.addEmpty);
    expect(host.querySelector<HTMLButtonElement>(`button[aria-label="${t.addWho}"]`)?.disabled).toBe(true);
    expect(host.textContent!.indexOf(t.addTitle)).toBeLessThan(host.textContent!.indexOf('Maya Example'));
    const listener = vi.fn();
    window.addEventListener('doc:open-settings', listener);
    try {
      await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent === t.workspacePeople)!.click(); });
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ detail: { section: 'ws-members' } }));
    } finally { window.removeEventListener('doc:open-settings', listener); }
    expect(mocks.setEdge).not.toHaveBeenCalled();
  });

  it('guides department owners without workspace invite authority to a workspace admin', async () => {
    mocks.viewer.role = 'member';
    await render(<DepartmentAccessPanel departmentId={D} />);
    expect(host.textContent).toContain(t.addTitle);
    expect(host.textContent).toContain(t.askWorkspaceAdmin);
    expect(host.textContent).not.toContain(t.workspacePeople);
  });

  it('removes a member from the row menu only after confirmation, binding the department revision', async () => {
    mocks.confirm.mockResolvedValue(true);
    await render(<DepartmentAccessPanel departmentId={D} />);
    await openActions('Maya Example');
    await chooseItem(t.remove);
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ description: t.removeDescription.replace('{name}', 'Maya Example') }));
    expect(mocks.removeEdge).toHaveBeenCalledWith(W, D, { principal: { kind: 'user', id: 'member-fixture' }, expectedRevision: 5 });
  });

  it('sets an end date from the row menu as the end of the chosen day', async () => {
    await render(<DepartmentAccessPanel departmentId={D} />);
    await openActions('Maya Example');
    await chooseItem(t.setEndDate);
    const input = host.querySelector<HTMLInputElement>('li input[type="date"]')!;
    await setDate(input, '2099-03-04');
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === t.saveEndDate)!.click(); });
    await flush();
    expect(mocks.setEdge).toHaveBeenCalledWith(W, D, { principal: { kind: 'user', id: 'member-fixture' }, clearance: 'internal', expiresAt: new Date('2099-03-04T23:59:59').toISOString(), expectedRevision: 5 });
    expect(host.querySelector('li input[type="date"]')).toBeNull();
  });

  it('adds a person with the chosen clearance and an optional end date', async () => {
    await render(<DepartmentAccessPanel departmentId={D} />);
    expect(host.textContent).toContain(t.addTitle);
    await act(async () => { host.querySelector<HTMLButtonElement>(`button[aria-label="${t.addWho}"]`)!.click(); });
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(node => node.textContent?.startsWith('Noor Example'));
    expect(option).toBeDefined();
    // People already in the department are not offered again.
    expect([...document.querySelectorAll('[role="option"]')].some(node => node.textContent?.startsWith('Maya Example'))).toBe(false);
    await act(async () => { option!.click(); });
    const until = [...host.querySelectorAll<HTMLInputElement>('input[type="date"]')].at(-1)!;
    await setDate(until, '2099-01-31');
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === t.add)!.click(); });
    await flush();
    expect(mocks.setEdge).toHaveBeenCalledWith(W, D, { principal: { kind: 'user', id: 'new-fixture' }, clearance: 'internal', expiresAt: new Date('2099-01-31T23:59:59').toISOString(), expectedRevision: 5 });
  });

  it('explains a removal the panel cannot make instead of failing silently', async () => {
    mocks.confirm.mockResolvedValue(true);
    const { DepartmentRequestError } = await import('@/lib/api/departments');
    mocks.removeEdge.mockRejectedValue(new DepartmentRequestError('department_access_via_grant'));
    await render(<DepartmentAccessPanel departmentId={D} />);
    await openActions('Maya Example');
    await chooseItem(t.remove);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(t.errorViaGrant);
  });

  it('a grant-derived row shows temporary access and no actions', async () => {
    mocks.edges.mockResolvedValue({ edges: [
      { departmentId: D, principal: { kind: 'user', id: 'owner-fixture' }, clearance: 'confidential', expiresAt: null, origin: 'owner' },
      { departmentId: D, principal: { kind: 'user', id: 'member-fixture' }, clearance: 'internal', expiresAt: '2099-01-01T00:00:00.000Z', origin: 'grant' },
    ] });
    await render(<DepartmentAccessPanel departmentId={D} />);
    expect(host.textContent).toContain(t.viaGrant);
    expect(host.querySelector(`[aria-label="${t.actionsLabel.replace('{name}', 'Maya Example')}"]`)).toBeNull();
  });

  it('a non-owner member sees the roster read-only', async () => {
    mocks.departments.mockResolvedValue({ departments: [entry({ isOwner: false })], homes: [] });
    await render(<DepartmentAccessPanel departmentId={D} />);
    expect(host.textContent).toContain(t.readOnly);
    expect(host.querySelector(`[aria-label="${t.actionsLabel.replace('{name}', 'Maya Example')}"]`)).toBeNull();
    expect(host.textContent).not.toContain(t.addTitle);
  });

  it('the workspace owner outside a department sees only break-glass, which asks for confirmation and a reason', async () => {
    mocks.departments.mockResolvedValue({ departments: [entry({ isOwner: false, myClearance: null })], homes: [] });
    mocks.confirm.mockResolvedValue(true); mocks.prompt.mockResolvedValue('Owner left the company');
    await render(<DepartmentAccessPanel departmentId={D} />);
    expect(host.textContent).not.toContain('Maya Example');
    const join = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes(t.breakGlass))!;
    await act(async () => { join.click(); });
    await flush();
    expect(mocks.breakGlass).toHaveBeenCalledWith(W, D, 'Owner left the company');
  });

  it('home department offers only departments the person is in, plus General', async () => {
    mocks.departments.mockResolvedValue({ departments: [entry(), entry({ departmentId: 'other', name: 'Board', myClearance: null })], homes: [{ principal: { kind: 'user', id: 'owner-fixture' }, departmentId: null }] });
    await render(<HomeDepartmentControls />);
    expect(host.textContent).toContain(en.homeDepartment.title);
    expect(host.textContent).toContain(en.homeDepartment.none);
  });

  it('home department stays painted through the stream catch-up and purges on a real identity change', async () => {
    // The workspace stream reconnects every ~5 minutes and its catch-up fires
    // WORKSPACE_IDENTITY_REFRESH; purging on it blinked the section to a skeleton.
    await render(<HomeDepartmentControls />);
    expect(host.textContent).toContain(en.homeDepartment.title);
    let finish!: (value: unknown) => void;
    mocks.departments.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => { window.dispatchEvent(new CustomEvent(WORKSPACE_IDENTITY_REFRESH_EVENT, { detail: { workspaceId: W, catchUp: true } })); });
    await flush();
    expect(mocks.departments).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain(en.homeDepartment.title);
    const fresh = { departments: [entry()], homes: [{ principal: { kind: 'user', id: 'owner-fixture' }, departmentId: null }] };
    await act(async () => finish(fresh));
    expect(host.textContent).toContain(en.homeDepartment.title);
    // A server-sent identity change drops the previous answer before repainting.
    mocks.departments.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => { window.dispatchEvent(new CustomEvent(WORKSPACE_IDENTITY_REFRESH_EVENT, { detail: { workspaceId: W } })); });
    expect(host.textContent).not.toContain(en.homeDepartment.title);
    await act(async () => finish(fresh));
    expect(host.textContent).toContain(en.homeDepartment.title);
  });

  it('carries complete copy in all four locales, with no em dash', () => {
    for (const dict of [ja, zh, zhCN]) {
      expect(Object.keys(dict.departmentAccess)).toEqual(Object.keys(en.departmentAccess));
      expect(Object.keys(dict.homeDepartment)).toEqual(Object.keys(en.homeDepartment));
    }
    for (const dict of [en, ja, zh, zhCN]) for (const value of [...Object.values(dict.departmentAccess), ...Object.values(dict.homeDepartment)]) {
      expect(value.trim().length).toBeGreaterThan(0);
      expect(value).not.toContain('—');
    }
  });
});
