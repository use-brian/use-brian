// @vitest-environment jsdom
/**
 * Shared Project foundation journey (platform
 * docs/plans/project-shared-spaces-implementation.md §15.2, §15.5): creation
 * defaults with removable primary Brian, owner versus participant controls,
 * the separate workspace-owner oversight disclosure, the shared/private chat
 * choice, the Project collection destination, and protected cache
 * contraction. Transport is mocked; selection and command state are real.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const ports = vi.hoisted(() => ({
  create: vi.fn(), setParticipant: vi.fn(), removeParticipant: vi.fn(), setOwner: vi.fn(), transfer: vi.fn(), recover: vi.fn(),
  preview: vi.fn(), apply: vi.fn(), createRoom: vi.fn(), push: vi.fn(), patchRooms: vi.fn(), refresh: vi.fn(),
  confirm: vi.fn(async () => true), prompt: vi.fn(async () => 'Lead on leave'), fetch: vi.fn(),
}));
vi.mock('@/lib/auth-fetch', () => ({ authFetch: ports.fetch }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: ports.push }) }));
vi.mock('@/lib/api/context-scopes', () => ({
  createContextProject: ports.create, setProjectParticipant: ports.setParticipant, removeProjectParticipant: ports.removeParticipant,
  setProjectOwner: ports.setOwner, transferProjectOwnership: ports.transfer, recoverProjectOwnership: ports.recover,
  previewProjectConversion: ports.preview, applyProjectConversion: ports.apply,
}));
vi.mock('@/lib/api/sessions', () => ({ createWorkspaceSession: ports.createRoom }));
vi.mock('@/lib/chat-surface-data', () => ({ patchSharedChatSessions: ports.patchRooms }));
vi.mock('@/lib/chat-session-events', () => ({ dispatchChatSessionsRefresh: ports.refresh }));
vi.mock('@/components/ui/confirm-dialog', () => ({ confirmDialog: ports.confirm }));
vi.mock('@/components/ui/prompt-dialog', () => ({ promptDialog: ports.prompt }));
vi.mock('@/components/ui/checkbox', () => ({
  Checkbox: ({ checked, disabled, onCheckedChange }: { checked: boolean; disabled?: boolean; onCheckedChange: (v: boolean) => void }) =>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onCheckedChange(event.target.checked)} />,
}));
vi.mock('@/components/ui/searchable-select', () => ({
  SearchableSelect: ({ items, onValueChange, 'aria-label': label }: { items: Array<{ value: string; label: string }>; onValueChange: (v: string) => void; 'aria-label': string }) =>
    <div aria-label={label}>{items.map(item => <button key={item.value} type="button" onClick={() => onValueChange(item.value)}>{`pick ${item.label}`}</button>)}</div>,
}));
vi.mock('@/lib/i18n/client', async () => { const { en } = await import('@/lib/i18n/dictionaries/en'); return { useT: () => en }; });
import { en } from '@/lib/i18n/dictionaries/en';
import { ProjectCreateDialog } from '../project-create-dialog';
import { ProjectAccessPanel } from '../project-access-panel';
import { ProjectChatLauncher } from '../project-chat-launcher';
import { groupRowsBySharedProject, groupRowsByTeamspace } from '@/lib/sidebar-tree';
import { projectSharedCapabilityCacheKey } from '@/lib/surface-prefetch';
import { createDraftOnServer, type ViewListRow } from '@/lib/api/views';
import type { ProjectRoster } from '@/lib/api/context-scopes';

const t = en.contextScope.sharedProjects;
let host: HTMLDivElement, root: Root;
const render = async (node: React.ReactNode) => { await act(async () => root.render(node)); };
const button = (label: string) => Array.from(host.querySelectorAll('button')).find(b => b.textContent === label);
const click = async (label: string) => { const b = button(label); if (!b) throw new Error(`no button ${label}`); await act(async () => b.click()); };
const people = [{ userId: 'me', name: 'Mira Owner' }, { userId: 'pat', name: 'Pat Example' }, { userId: 'sam', name: 'Sam Example' }];
const assistants = [{ id: 'brian', name: 'Brian', kind: 'primary' }, { id: 'ops', name: 'Ops', kind: 'standard' }];
const roster = (myRole: ProjectRoster['myRole']): ProjectRoster => ({
  projectId: 'atlas', status: 'active', revision: 4, myRole, origin: 'created',
  members: [
    { principal: { kind: 'user', id: 'me' }, name: 'Mira Owner', email: null, isOwner: true, expiresAt: null, origin: 'creator' },
    { principal: { kind: 'user', id: 'pat' }, name: 'Pat Example', email: null, isOwner: false, expiresAt: null, origin: 'invited' },
    { principal: { kind: 'assistant', id: 'brian' }, name: 'Brian', email: null, isOwner: false, expiresAt: null, origin: 'invited' },
  ],
  oversight: [{ userId: 'ws-owner', name: 'Wren Owner', isMember: false }],
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  ports.confirm.mockResolvedValue(true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('[COMP:app-web/project-shared-journey] Shared Project foundation journey', () => {
  it('creates with name and People/Assistants: primary Brian preselected and removable, nothing else implied', async () => {
    ports.create.mockResolvedValue({ id: 'atlas' });
    const onCreated = vi.fn();
    await render(<ProjectCreateDialog workspaceId="ws" meId="me" people={people} assistants={assistants} onCreated={onCreated} onCancel={() => undefined} />);
    expect(host.textContent).toContain(t.you);
    expect(host.textContent).toContain(t.primaryPreselected);
    const boxes = () => Array.from(host.querySelectorAll<HTMLInputElement>('input[type=checkbox]'));
    // People: only the others (the creator is the owner); Assistants: Brian checked, Ops not.
    expect(boxes().map(b => b.checked)).toEqual([false, false, true, false]);
    const input = host.querySelector<HTMLInputElement>('input:not([type])')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Atlas launch'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => boxes()[0].click()); // Pat
    await click(t.create);
    expect(ports.create).toHaveBeenCalledWith('ws', { name: 'Atlas launch', participants: { userIds: ['pat'], assistantIds: ['brian'] } });
    expect(onCreated).toHaveBeenCalled();
    // Deselecting Brian creates without an assistant.
    ports.create.mockClear();
    await act(async () => boxes()[2].click());
    await click(t.create);
    expect(ports.create).toHaveBeenCalledWith('ws', { name: 'Atlas launch', participants: { userIds: ['pat'], assistantIds: [] } });
  });

  it('shows an actionable message when the selected assistant is unavailable, and notes when no Brian exists', async () => {
    ports.create.mockRejectedValue(new Error('project_assistant_unavailable'));
    await render(<ProjectCreateDialog workspaceId="ws" meId="me" people={people} assistants={[{ id: 'ops', name: 'Ops', kind: 'standard' }]} onCreated={() => undefined} onCancel={() => undefined} />);
    expect(host.textContent).toContain(t.noPrimary);
    const input = host.querySelector<HTMLInputElement>('input:not([type])')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Beacon'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await click(t.create);
    expect(host.querySelector('[role=alert]')?.textContent).toBe(t.assistantUnavailable);
  });

  it('gives owners roster controls with the current revision; participants see the roster only; oversight is disclosed separately', async () => {
    const changed = vi.fn();
    await render(<ProjectAccessPanel workspaceId="ws" projectId="atlas" roster={roster('owner')} people={people} assistants={assistants}
      meId="me" workspaceRole="member" sharedEnabled onChanged={changed} />);
    expect(host.querySelector('[data-testid=project-oversight]')?.textContent).toContain('Wren Owner');
    expect(host.textContent).not.toContain(t.recover);
    await click(`pick Sam Example`);
    await click(t.addPerson);
    expect(ports.setParticipant).toHaveBeenCalledWith('ws', 'atlas', { kind: 'user', id: 'sam' }, 4);
    await click(t.remove);
    expect(ports.confirm).toHaveBeenCalled();
    expect(ports.removeParticipant).toHaveBeenCalledWith('ws', 'atlas', { kind: 'user', id: 'pat' }, 4);
    expect(changed).toHaveBeenCalled();

    await render(<ProjectAccessPanel workspaceId="ws" projectId="atlas" roster={roster('participant')} people={people} assistants={assistants}
      meId="pat" workspaceRole="member" sharedEnabled onChanged={() => undefined} />);
    expect(button(t.remove)).toBeUndefined();
    expect(button(t.addPerson)).toBeUndefined();
    expect(host.textContent).toContain(t.roleParticipant);
  });

  it('reports a stale revision and a last-owner refusal without claiming success', async () => {
    ports.removeParticipant.mockRejectedValueOnce(new Error('project_revision_stale'));
    await render(<ProjectAccessPanel workspaceId="ws" projectId="atlas" roster={roster('owner')} people={people} assistants={assistants}
      meId="me" workspaceRole="member" sharedEnabled onChanged={() => undefined} />);
    await click(t.remove);
    expect(host.querySelector('[role=alert]')?.textContent).toBe(t.stale);
    ports.setOwner.mockRejectedValueOnce(new Error('project_last_owner'));
    await click(t.makeOwner);
    expect(host.querySelector('[role=alert]')?.textContent).toBe(t.lastOwner);
  });

  it('lets the workspace owner recover ownership with an audited reason, read-only otherwise', async () => {
    await render(<ProjectAccessPanel workspaceId="ws" projectId="atlas" roster={roster('oversight')} people={people} assistants={assistants}
      meId="ws-owner" workspaceRole="owner" sharedEnabled onChanged={() => undefined} />);
    expect(host.textContent).toContain(t.roleOversight);
    expect(button(t.remove)).toBeUndefined();
    await click(t.recover);
    expect(ports.recover).toHaveBeenCalledWith('ws', 'atlas', { reason: 'Lead on leave', expectedRevision: 4 });
  });

  it('converts a legacy Project only from an explicit reviewed selection, never preselected', async () => {
    ports.preview.mockResolvedValue({ projectId: 'legacy', projectName: 'Legacy', ownerUserId: 'ws-owner', userIds: ['pat', 'ws-owner'], assistantIds: [],
      legacyParticipation: { userIds: ['sam'], assistantIds: ['ops'] }, linkedMaterial: { tasks: 2, pages: 1, files: 0, chats: 0 }, relabelled: 0, requestHash: 'a'.repeat(64) });
    await render(<ProjectAccessPanel workspaceId="ws" projectId="legacy" roster={null} people={people} assistants={assistants}
      meId="ws-owner" workspaceRole="owner" sharedEnabled onChanged={() => undefined} />);
    const boxes = Array.from(host.querySelectorAll<HTMLInputElement>('input[type=checkbox]'));
    expect(boxes.every(b => !b.checked)).toBe(true);
    expect(button(t.convertApply)?.disabled).toBe(true);
    await act(async () => boxes.find((_, i) => i === 1)!.click()); // Pat
    await click(t.convertPreview);
    expect(ports.preview).toHaveBeenCalledWith('ws', 'legacy', { userIds: ['pat'], assistantIds: [] });
    expect(host.textContent).toContain('3 linked items keep their current access.');
    await click(t.convertApply);
    expect(ports.apply).toHaveBeenCalledWith('ws', 'legacy', expect.objectContaining({ userIds: ['pat'], assistantIds: [], requestHash: 'a'.repeat(64) }));
    // A non-owner never sees conversion.
    await render(<ProjectAccessPanel workspaceId="ws" projectId="legacy" roster={null} people={people} assistants={assistants}
      meId="pat" workspaceRole="admin" sharedEnabled onChanged={() => undefined} />);
    expect(host.textContent).toBe('');
  });

  it('starts new Project chats shared by default with a visible private option; oversight starts private only', async () => {
    ports.createRoom.mockResolvedValue({ id: 'room-1' });
    let audience: 'shared' | 'private' = 'shared';
    const draw = (canShare: boolean) => render(<ProjectChatLauncher workspaceId="ws" projectId="atlas" assistantId="brian" audience={audience}
      onAudience={next => { audience = next; }} canShare={canShare} disabled={false} />);
    await draw(true);
    const radios = () => Array.from(host.querySelectorAll('[role=radio]'));
    expect(radios().map(r => [r.textContent, r.getAttribute('aria-checked')])).toEqual([[t.chatShared, 'true'], [t.chatPrivate, 'false']]);
    expect(host.textContent).toContain(t.chatSharedHint);
    await act(async () => (radios()[0] as HTMLButtonElement).click());
    const start = Array.from(host.querySelectorAll('button')).find(b => b.textContent === t.chatShared && b.getAttribute('role') !== 'radio')!;
    await act(async () => start.click());
    expect(ports.createRoom).toHaveBeenCalledWith('ws', 'brian', { contextGroupId: null, contextProjectId: 'atlas' });
    expect(ports.push).toHaveBeenCalledWith('/w/ws/chat?v=workspace&s=room-1');
    await draw(false);
    expect(radios().map(r => r.textContent)).toEqual([t.chatPrivate]);
    expect(host.textContent).toContain(t.chatPrivateHint);
  });

  it('files new Project pages in the collection: the destination reaches the wire and the rows never fall into Private', async () => {
    const row = (id: string, extra: Partial<ViewListRow>) => ({ id, teamspaceId: null, sharedProjectId: null, ...extra }) as ViewListRow;
    const rows = [row('a', { sharedProjectId: 'atlas' }), row('b', {}), row('c', { teamspaceId: 'general' })];
    expect([...groupRowsBySharedProject(rows)].map(([k, v]) => [k, v.map(r => r.id)])).toEqual([['atlas', ['a']]]);
    expect([...groupRowsByTeamspace(rows)].map(([k, v]) => [k, v.map(r => r.id)])).toEqual([[null, ['b']], ['general', ['c']]]);
    ports.fetch.mockResolvedValue(new Response(JSON.stringify({ id: 'p' }), { status: 201 }))
    await createDraftOnServer({ workspaceId: 'ws', id: 'p', sharedProjectId: 'atlas' });
    const body = JSON.parse(String((ports.fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ id: 'p', sharedProjectId: 'atlas' });
    expect(body).not.toHaveProperty('teamspaceId');
  });

  it('keeps shared-space state inside the Project cache prefix the workspace_config signal invalidates', () => {
    expect(projectSharedCapabilityCacheKey('ws').startsWith('project:ws')).toBe(true);
  });
});
