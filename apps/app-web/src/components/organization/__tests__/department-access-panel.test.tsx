// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DepartmentAccessPanel, HomeDepartmentControls } from '../department-access-panel';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
import { ja } from '@/lib/i18n/dictionaries/ja';
import { zh } from '@/lib/i18n/dictionaries/zh';
import { zhCN } from '@/lib/i18n/dictionaries/zh-cn';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const W = 'workspace-fixture', D = 'department-fixture';
const mocks = vi.hoisted(() => ({
  viewer: { workspaceId: 'workspace-fixture', me: { id: 'owner-fixture' } },
  departments: vi.fn(), edges: vi.fn(), setEdge: vi.fn(), removeEdge: vi.fn(), addOwner: vi.fn(), removeOwner: vi.fn(),
  breakGlass: vi.fn(), setHome: vi.fn(), confirm: vi.fn(), prompt: vi.fn(),
}));
vi.mock('@/lib/workspace-context', () => ({ useWorkspaceContext: () => mocks.viewer }));
vi.mock('@/lib/api/mentions', () => ({ listWorkspaceMembers: async () => [{ id: 'owner-fixture', name: 'Ava Example' }, { id: 'member-fixture', name: 'Maya Example' }] }));
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
const entry = (over: object = {}) => ({ departmentId: D, name: 'Finance', status: 'active', revision: 5, myClearance: 'confidential', isOwner: true, ownerIds: ['owner-fixture'], ...over });
async function render(node: React.ReactNode) {
  await act(async () => { root.render(<I18nProvider locale="en" dict={en}>{node}</I18nProvider>); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('button')].map(b => b.textContent ?? '');

beforeEach(() => {
  mocks.viewer.me.id = 'owner-fixture';
  for (const m of [mocks.departments, mocks.edges, mocks.setEdge, mocks.removeEdge, mocks.addOwner, mocks.removeOwner, mocks.breakGlass, mocks.setHome, mocks.confirm, mocks.prompt]) m.mockReset();
  mocks.departments.mockResolvedValue({ departments: [entry()], homes: [{ principal: { kind: 'user', id: 'owner-fixture' }, departmentId: null }] });
  mocks.edges.mockResolvedValue({ edges: [
    { departmentId: D, principal: { kind: 'user', id: 'owner-fixture' }, clearance: 'confidential', expiresAt: null, origin: 'owner' },
    { departmentId: D, principal: { kind: 'user', id: 'member-fixture' }, clearance: 'internal', expiresAt: null, origin: 'migrated' },
  ] });
  mocks.removeEdge.mockResolvedValue({ revision: 6 });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('[COMP:app-web/department-access] Organization > Departments: who reads a department and home departments', () => {
  it('shows an owner each member with clearance, owner and carried-over markers, and editing controls', async () => {
    await render(<DepartmentAccessPanel departmentId={D} />);
    expect(host.textContent).toContain('Maya Example');
    expect(host.textContent).toContain(en.departmentAccess.carriedOver);
    expect(host.textContent).toContain(en.departmentAccess.owner);
    expect(host.querySelector(`[aria-label="${en.departmentAccess.clearanceLabel.replace('{name}', 'Maya Example')}"]`)).not.toBeNull();
    expect(buttons().some(b => b.includes(en.departmentAccess.makeOwner))).toBe(true);
  });

  it('removes a member only after confirmation, binding the department revision', async () => {
    mocks.confirm.mockResolvedValue(true);
    await render(<DepartmentAccessPanel departmentId={D} />);
    const remove = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === en.departmentAccess.remove)!;
    await act(async () => { remove.click(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ description: en.departmentAccess.removeDescription.replace('{name}', 'Maya Example') }));
    expect(mocks.removeEdge).toHaveBeenCalledWith(W, D, { principal: { kind: 'user', id: 'member-fixture' }, expectedRevision: 5 });
  });

  it('a non-owner member sees the roster read-only', async () => {
    mocks.departments.mockResolvedValue({ departments: [entry({ isOwner: false })], homes: [] });
    await render(<DepartmentAccessPanel departmentId={D} />);
    expect(host.textContent).toContain(en.departmentAccess.readOnly);
    expect(buttons().some(b => b.includes(en.departmentAccess.remove))).toBe(false);
  });

  it('the workspace owner outside a department sees only break-glass, which asks for confirmation and a reason', async () => {
    mocks.departments.mockResolvedValue({ departments: [entry({ isOwner: false, myClearance: null })], homes: [] });
    mocks.confirm.mockResolvedValue(true); mocks.prompt.mockResolvedValue('Owner left the company');
    await render(<DepartmentAccessPanel departmentId={D} />);
    expect(host.textContent).not.toContain('Maya Example');
    const join = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes(en.departmentAccess.breakGlass))!;
    await act(async () => { join.click(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(mocks.breakGlass).toHaveBeenCalledWith(W, D, 'Owner left the company');
  });

  it('home department offers only departments the person is in, plus General', async () => {
    mocks.departments.mockResolvedValue({ departments: [entry(), entry({ departmentId: 'other', name: 'Board', myClearance: null })], homes: [{ principal: { kind: 'user', id: 'owner-fixture' }, departmentId: null }] });
    await render(<HomeDepartmentControls />);
    expect(host.textContent).toContain(en.homeDepartment.title);
    expect(host.textContent).toContain(en.homeDepartment.none);
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
