// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ user: 'actor', list: vi.fn() }));
vi.mock('@/lib/api/views', () => ({ listWorkspaceAssistants: fixture.list }));
vi.mock('@/lib/offline/application-write-authority', () => ({ currentOfflineWriteAuthority: (workspaceId: string) => ({ apiOrigin: 'https://api.example', viewerId: fixture.user, workspaceId }) }));
import { PrimaryAssistantProvider, usePrimaryAssistant } from '../primary-assistant';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
describe('[COMP:app-web/primary-assistant-context] offline restart', () => {
  it('restores capture routing offline, isolates identity and evicts a live denial', async () => {
    localStorage.clear(); fixture.user = 'actor';
    const element = document.createElement('div'); let root = createRoot(element); let value!: ReturnType<typeof usePrimaryAssistant>;
    function Probe() { value = usePrimaryAssistant(); return null; }
    const tree = () => <PrimaryAssistantProvider workspaceId="workspace"><Probe /></PrimaryAssistantProvider>;
    fixture.list.mockResolvedValue([{ id: 'assistant', kind: 'primary' }]);
    await act(async () => root.render(tree())); expect(value.assistantId).toBe('assistant');
    act(() => root.unmount()); root = createRoot(element); fixture.list.mockRejectedValue(new TypeError('offline'));
    await act(async () => root.render(tree())); expect(value.assistantId).toBe('assistant');
    fixture.user = 'other'; await act(async () => root.render(tree())); expect(value.assistantId).toBeNull();
    fixture.user = 'actor'; fixture.list.mockRejectedValue(Object.assign(new Error('denied'), { status: 403 }));
    await act(async () => root.render(tree())); expect(value.assistantId).toBeNull();
    expect(Object.values(localStorage)).not.toContain('assistant'); act(() => root.unmount());
  });
});
