import { describe, expect, it, vi } from 'vitest';
import { automaticExtensionBrowser } from '../automatic-extension-browser';
const installation = '10000000-0000-4000-8000-000000000001';
function harness() {
  const saved = new Map<string, string>();
  type Profile = Awaited<ReturnType<Parameters<typeof automaticExtensionBrowser>[0]['list']>>[number];
  const manual: Profile = { id: 'manual', name: 'Existing desktop browser', workspaceId: 'w', ownerUserId: 'u', scope: 'owner', departmentId: null, defaultBackend: 'local', enabledAssistantIds: [] };
  const rows: Profile[] = [manual];
  const deps = { userId: 'u', workspaceId: 'w', label: 'This browser', storage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } },
    list: vi.fn(async () => [...rows]), create: vi.fn(async (name: string) => { const p = { ...manual, id: 'extension', name }; rows.push(p); return p as Profile | null; }),
    enable: vi.fn(async (_id: string, _ids: string[]) => true), status: vi.fn(async () => ({ configured: true, connected: false })), pair: vi.fn(async () => true) };
  return { deps, rows, saved, service: automaticExtensionBrowser(deps), connect: () => automaticExtensionBrowser(deps).connect(installation, undefined, new AbortController().signal, () => true) };
}
describe('[COMP:app-web/automatic-extension-browser] implicit private browser connection', () => {
  it('creates one dedicated identity instead of selecting an existing desktop/manual profile', async () => {
    const h = harness(); expect(h.deps.create).not.toHaveBeenCalled();
    expect(await h.connect()).toBe('extension');
    expect(h.deps.create.mock.calls[0][0]).toMatch(/^This browser \([a-f0-9]{24}\)$/);
    expect(h.deps.pair).toHaveBeenCalledWith('extension', expect.any(AbortSignal), expect.any(Function));
    expect(h.deps.enable).not.toHaveBeenCalled();
    expect(JSON.stringify([...h.saved])).not.toMatch(/token|credential|secret/i);
  });
  it('reopens its own connection without minting again or releasing Stop', async () => {
    const h = harness(); await h.connect(); h.deps.pair.mockClear(); h.deps.status.mockClear();
    await automaticExtensionBrowser(h.deps).connect(installation, 'extension', new AbortController().signal, () => true);
    expect(h.deps.create).toHaveBeenCalledOnce(); expect(h.deps.pair).not.toHaveBeenCalled(); expect(h.deps.status).not.toHaveBeenCalled();
  });
  it('does not replace another connected client', async () => {
    const h = harness(); h.deps.status.mockResolvedValue({ configured: true, connected: true });
    await expect(h.connect()).rejects.toThrow('browser_connection_busy'); expect(h.deps.pair).not.toHaveBeenCalled();
  });
  it('does not recreate an intentionally removed or reclassified saved identity', async () => {
    const h = harness(); await h.connect(); h.deps.create.mockClear(); h.rows.splice(1);
    await expect(h.connect()).rejects.toThrow('browser_identity_changed'); expect(h.deps.create).not.toHaveBeenCalled();
  });
  it('converges a duplicate-create race through the stable installation name', async () => {
    const h = harness(); h.deps.create.mockImplementation(async name => { h.rows.push({ ...h.rows[0], id: 'raced', name }); return null; });
    expect(await h.connect()).toBe('raced'); expect(h.deps.pair).toHaveBeenCalledWith('raced', expect.anything(), expect.anything());
  });
  it('grants only the explicitly selected assistant at send time and preserves other grants', async () => {
    const h = harness(); await h.service.connect(installation, undefined, new AbortController().signal, () => true);
    h.rows[1].enabledAssistantIds = ['existing-assistant'];
    await h.service.prepare('extension', 'selected-assistant', () => true);
    expect(h.deps.enable).toHaveBeenCalledWith('extension', ['existing-assistant', 'selected-assistant']);
    await expect(h.service.prepare('manual', 'selected-assistant', () => true)).rejects.toThrow('browser_identity_changed');
  });
  it('rechecks private local ownership before enablement and refuses policy changes', async () => {
    for (const patch of [{ scope: 'workspace' }, { defaultBackend: 'cloud' }, { departmentId: 'department' }, { ownerUserId: 'another-user' }]) {
      const h = harness(); await h.service.connect(installation, undefined, new AbortController().signal, () => true);
      Object.assign(h.rows[1], patch);
      await expect(h.service.prepare('extension', 'selected', () => true)).rejects.toThrow('browser_identity_changed');
      expect(h.deps.enable).not.toHaveBeenCalled();
    }
  });
  it('fences delayed provisioning after an account switch', async () => {
    const h = harness(); let current = true;
    h.deps.list.mockImplementation(async () => { current = false; return h.rows; });
    await expect(h.service.connect(installation, undefined, new AbortController().signal, () => current)).rejects.toThrow('account_changed');
    expect(h.deps.create).not.toHaveBeenCalled(); expect(h.deps.pair).not.toHaveBeenCalled();
  });
});

it('[COMP:app-web/automatic-extension-browser] explicitly recovers a deleted identity without changing an existing policy', async () => {
  const h = harness(); await h.connect(); h.rows.splice(1);
  await automaticExtensionBrowser(h.deps).connect(installation, undefined, new AbortController().signal, () => true, true);
  expect(h.deps.create).toHaveBeenCalledTimes(2);
  h.rows[1].scope = 'workspace';
  await expect(automaticExtensionBrowser(h.deps).connect(installation, undefined, new AbortController().signal, () => true, true)).rejects.toThrow('browser_identity_changed');
  expect(h.deps.create).toHaveBeenCalledTimes(2);
});
