// @vitest-environment jsdom
/**
 * Brief journey on existing surfaces (project-briefs.md -> "User experience";
 * plan §7 "Human/Brian parity", "Owner autosave vs Apply"): create, inspect,
 * autosaved draft, explicit Apply (no second confirmation), propose, dismiss,
 * history restore, Department rule selection, oversight and repair. The API
 * is mocked with in-memory state; component state and commands are real.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BriefView } from '@/lib/api/briefs';

const api = vi.hoisted(() => ({
  getBriefByOwner: vi.fn(), ensureBrief: vi.fn(), saveBriefDraft: vi.fn(), proposeBriefChange: vi.fn(), applyBriefDirection: vi.fn(),
  dismissBriefProposal: vi.fn(), listBriefRevisions: vi.fn(), restoreBriefRevision: vi.fn(), listDepartmentBriefs: vi.fn(),
  selectBriefDepartments: vi.fn(), repairBrief: vi.fn(), confirm: vi.fn(),
}));
vi.mock('@/lib/api/briefs', async () => {
  class BriefRequestError extends Error { constructor(readonly code: string, readonly status: number) { super(code) } }
  return { ...api, BriefRequestError };
});
vi.mock('@/components/ui/confirm-dialog', () => ({ confirmDialog: api.confirm }));
// The pane also mounts the live work section (project-briefs.md -> "Work");
// its own behaviour is covered by brief-work.test.tsx.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/lib/api/work', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/work')>()),
  fetchWork: vi.fn(async () => ({ scope: { kind: 'project', id: 'atlas' }, viewer: { memberId: 'm1' },
    sections: { needsYou: [], myWork: [], needsAssignment: [] }, counts: { needsYou: 0, myWork: 0, needsAssignment: 0 }, generatedAt: '2026-10-13T00:00:00Z' })),
}));
vi.mock('@/components/ui/checkbox', () => ({
  Checkbox: ({ checked, onCheckedChange }: { checked: boolean; onCheckedChange: (v: boolean) => void }) =>
    <input type="checkbox" checked={checked} onChange={event => onCheckedChange(event.target.checked)} />,
}));
vi.mock('@/lib/i18n/client', async () => {
  const { en } = await import('@/lib/i18n/dictionaries/en');
  return { useT: () => en, useLocale: () => 'ja', format: (text: string, vars: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_m, key) => vars[key] ?? '') };
});
import { en } from '@/lib/i18n/dictionaries/en';
import { BriefPane } from '../brief-pane';
import { BriefEntry } from '../brief-entry';

const t = en.briefs;
let host: HTMLDivElement, root: Root;
const render = async (node: React.ReactNode) => { await act(async () => root.render(node)); };
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const buttons = (label: string) => Array.from(host.querySelectorAll('button')).filter(b => b.textContent === label);
const click = async (label: string, index = 0) => { const b = buttons(label)[index]; if (!b) throw new Error(`no button ${label}`); await act(async () => b.click()); await flush(); };
async function typeInto(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
}

function view(over: Partial<BriefView> = {}): BriefView {
  return {
    binding: { id: 'b1', ownerKind: 'project', ownerId: 'atlas', directionRevision: 1, selectionRevision: 0, updatedAt: '2026-10-12T00:00:00Z' },
    role: 'owner', pageId: 'page-1', missing: false, established: true,
    direction: { outcome: ['Ship the billing pilot'], rules: ['Finance approves invoices'], decisions: [] },
    context: { findings: [{ id: 'f1', kind: 'text', text: 'Vendor A quoted 12 weeks' }], questions: [], references: [] },
    proposals: [], myDraft: null, selections: [], ...over,
  };
}

describe('[COMP:app-web/brief-journey] Brief pane and entry on existing surfaces', () => {
  beforeEach(() => {
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    for (const fn of Object.values(api)) fn.mockReset();
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

  it('creates an empty Brief on demand in the viewer locale; nothing is generated from the name', async () => {
    api.getBriefByOwner.mockResolvedValueOnce(null).mockResolvedValue(view({ established: false, direction: { outcome: [], rules: [], decisions: [] }, binding: { ...view().binding, directionRevision: 0 } }));
    api.ensureBrief.mockResolvedValue(view());
    await render(<BriefPane workspaceId="w1" ownerKind="project" ownerId="atlas" />); await flush();
    expect(host.textContent).toContain(t.createHint);
    // Work pickup is not gated on creating the Brief or establishing Direction.
    expect(host.querySelector('[data-testid="brief-work"]')).not.toBeNull()
    await click(t.create);
    expect(api.ensureBrief).toHaveBeenCalledWith('w1', 'project', 'atlas', 'ja');
    expect(host.textContent).toContain(t.notEstablished);
    expect(host.textContent).toContain(t.noRevision);
  });

  it('owner autosave stores only a draft; Apply direction is the explicit acceptance with no second dialog', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.getBriefByOwner.mockResolvedValue(view());
    api.saveBriefDraft.mockResolvedValue({ id: 'd1' });
    api.applyBriefDirection.mockResolvedValue({ revisionId: 'r2', directionRevision: 2, replayed: false });
    await render(<BriefPane workspaceId="w1" ownerKind="project" ownerId="atlas" />); await flush();
    const outcome = host.querySelectorAll('textarea')[0] as HTMLTextAreaElement;
    expect(outcome.value).toBe('Ship the billing pilot');
    await typeInto(outcome, 'Ship the billing pilot\nTwo customers first');
    await act(async () => { vi.advanceTimersByTime(900); });
    await flush();
    expect(api.saveBriefDraft).toHaveBeenCalledWith('w1', 'b1', { outcome: ['Ship the billing pilot', 'Two customers first'], rules: ['Finance approves invoices'], decisions: [] });
    expect(api.applyBriefDirection).not.toHaveBeenCalled();
    // The accepted Direction shown is unchanged until Apply.
    expect(host.querySelector('[aria-labelledby="brief-direction"]')!.textContent).not.toContain('Two customers first');
    await click(t.apply);
    expect(api.confirm).not.toHaveBeenCalled();
    expect(api.applyBriefDirection).toHaveBeenCalledWith('w1', 'b1', expect.objectContaining({
      sections: { outcome: ['Ship the billing pilot', 'Two customers first'], rules: ['Finance approves invoices'], decisions: [] },
      expectedDirectionRevision: 1, expectedSelectionRevision: 0, activeWork: 'pause', idempotencyKey: expect.any(String),
    }));
  });

  it('participants propose instead of applying; proposals stay labelled pending and stale ones cannot be applied', async () => {
    api.getBriefByOwner.mockResolvedValue(view({ role: 'participant' }));
    api.proposeBriefChange.mockResolvedValue({ id: 'p9' });
    await render(<BriefPane workspaceId="w1" ownerKind="project" ownerId="atlas" />); await flush();
    expect(buttons(t.apply)).toHaveLength(0);
    expect(host.textContent).toContain(t.ownerOnly);
    await click(t.propose);
    expect(api.proposeBriefChange).toHaveBeenCalledWith('w1', 'b1', expect.objectContaining({ rules: ['Finance approves invoices'] }), [{ kind: 'human', label: 'Brief pane' }]);
    // Owner review: pending badge, evidence, Apply and Dismiss; a stale proposal needs review first.
    const proposals = [
      { id: 'p1', kind: 'proposal', status: 'open', authorUserId: 'pat', authorAssistantId: 'brian', summary: 'From the kickoff', baseDirectionRevision: 1, evidence: [{ kind: 'page', passage: 'Finance signs off' }], stale: false, restoreOf: null },
      { id: 'p2', kind: 'proposal', status: 'open', authorUserId: 'sam', authorAssistantId: null, summary: 'Old idea', baseDirectionRevision: 0, evidence: [], stale: true, restoreOf: null },
    ] as BriefView['proposals'];
    api.getBriefByOwner.mockResolvedValue(view({ proposals }));
    api.applyBriefDirection.mockResolvedValue({ revisionId: 'r2', directionRevision: 2, replayed: false });
    api.dismissBriefProposal.mockResolvedValue(undefined);
    await act(async () => root.unmount()); root = createRoot(host);
    await render(<BriefPane workspaceId="w1" ownerKind="project" ownerId="atlas" />); await flush();
    expect(host.textContent).toContain(t.pendingBadge);
    expect(host.textContent).toContain('Finance signs off');
    expect(host.textContent).toContain(t.staleBadge);
    expect(buttons(t.applyProposal)[1].disabled).toBe(true);
    await click(t.applyProposal, 0);
    expect(api.applyBriefDirection).toHaveBeenCalledWith('w1', 'b1', expect.objectContaining({ proposalId: 'p1', expectedDirectionRevision: 1 }));
    await click(t.dismiss, 1);
    expect(api.dismissBriefProposal).toHaveBeenCalledWith('w1', 'b1', 'p2');
  });

  it('history restores as a new proposal; Department rules are an explicit owner selection that grants no access', async () => {
    api.getBriefByOwner.mockResolvedValue(view({ binding: { ...view().binding, directionRevision: 2 }, selections: ['hidden-dept'] }));
    api.listBriefRevisions.mockResolvedValue([
      { id: 'r2', kind: 'apply', directionRevision: 2, selectionRevision: 0, actorUserId: 'me', actingAssistantId: null, activeWork: 'pause', createdAt: '2026-10-12T01:00:00Z' },
      { id: 'r1', kind: 'apply', directionRevision: 1, selectionRevision: 0, actorUserId: 'me', actingAssistantId: 'brian', activeWork: 'pause', createdAt: '2026-10-12T00:30:00Z' },
    ]);
    api.restoreBriefRevision.mockResolvedValue({ proposalId: 'p5' });
    api.listDepartmentBriefs.mockResolvedValue([{ bindingId: 'fin', departmentId: 'finance', name: 'Finance', directionRevision: 3 }]);
    api.selectBriefDepartments.mockResolvedValue({ selectionRevision: 1 });
    await render(<BriefPane workspaceId="w1" ownerKind="project" ownerId="atlas" />); await flush();
    await click(t.history);
    expect(buttons(t.restore)).toHaveLength(1) // only revisions older than the current one
    await click(t.restore);
    expect(api.restoreBriefRevision).toHaveBeenCalledWith('w1', 'b1', 'r1');
    expect(host.textContent).toContain(t.departmentsHint);
    await click(t.departments);
    expect(host.textContent).toContain(t.departmentUnavailable); // a selection the owner cannot see is named generically
    expect(host.textContent).not.toContain('hidden-dept');
    const finance = host.querySelector('[aria-labelledby="brief-departments"] input[type="checkbox"]') as HTMLInputElement;
    await act(async () => finance.click());
    await click(t.saveDepartments);
    expect(api.selectBriefDepartments).toHaveBeenCalledWith('w1', 'b1', expect.objectContaining({
      departmentBindingIds: ['hidden-dept', 'fin'], expectedSelectionRevision: 0, activeWork: 'pause',
    }));
  });

  it('workspace-owner oversight reads only; a missing Page offers the owner a repair from history; errors are typed', async () => {
    api.getBriefByOwner.mockResolvedValue(view({ role: 'oversight' }));
    await render(<BriefPane workspaceId="w1" ownerKind="project" ownerId="atlas" />); await flush();
    expect(host.textContent).toContain(t.oversight);
    expect(host.querySelectorAll('textarea')).toHaveLength(0);
    expect(buttons(t.apply)).toHaveLength(0);
    await act(async () => root.unmount()); root = createRoot(host);
    const { BriefRequestError } = await import('@/lib/api/briefs');
    api.getBriefByOwner.mockResolvedValue(view({ missing: true, pageId: null, ownerKind: undefined } as never));
    api.repairBrief.mockRejectedValueOnce(new BriefRequestError('brief_revision_stale', 409)).mockResolvedValue({ pageId: 'page-2' });
    await render(<BriefPane workspaceId="w1" ownerKind="department" ownerId="finance" />); await flush();
    expect(host.textContent).toContain(t.missing);
    expect(host.querySelector('[aria-labelledby="brief-departments"]')).toBeNull(); // Department Briefs select nothing
    await click(t.repair);
    expect(host.querySelector('[role="alert"]')!.textContent).toBe(t.errorStale);
    await click(t.repair);
    expect(api.repairBrief).toHaveBeenCalledTimes(2);
  });

  it('the Project detail entry is compact: revision, rule basis and pending count, opening the pane on demand', async () => {
    api.getBriefByOwner.mockResolvedValue(view({ selections: ['fin'], proposals: [{ id: 'p1', kind: 'proposal', status: 'open', authorUserId: 'pat', authorAssistantId: null, summary: null, baseDirectionRevision: 1, evidence: [], stale: false, restoreOf: null }] }));
    await render(<BriefEntry workspaceId="w1" ownerKind="project" ownerId="atlas" />); await flush();
    const text = host.textContent!;
    expect(text).toContain('Accepted revision 1');
    expect(text).toContain('1 Department rule sets selected');
    expect(text).toContain('1 pending');
    expect(host.querySelector('[data-testid="brief-pane"]')).toBeNull();
    await click(t.open);
    expect(host.querySelector('[data-testid="brief-pane"]')).not.toBeNull();
    expect((host.querySelector('a') as HTMLAnchorElement).getAttribute('href')).toBe('/w/w1/p/page-1');
  });
});
