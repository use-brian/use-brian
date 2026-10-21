import type { BrowserProfile } from './api/computer';

type Profile = Pick<BrowserProfile, 'id' | 'workspaceId' | 'ownerUserId' | 'name' | 'scope' | 'defaultBackend' | 'departmentId' | 'enabledAssistantIds'>;

/** Private browser identity for one installed extension. No browser consent lives here.
 * [COMP:app-web/automatic-extension-browser]
 */
export function automaticExtensionBrowser(deps: {
  userId: string;
  workspaceId: string;
  label: string;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  list: () => Promise<Profile[]>;
  create: (name: string) => Promise<Profile | null>;
  enable: (id: string, assistantIds: string[]) => Promise<boolean>;
  status: (id: string) => Promise<{ configured: boolean; connected: boolean }>;
  pair: (id: string, signal: AbortSignal, current: () => boolean) => Promise<boolean>;
}) {
  let managedId: string | undefined;
  const owned = (p: Profile | undefined): p is Profile => !!p && p.workspaceId === deps.workspaceId && p.ownerUserId === deps.userId
    && p.scope === 'owner' && p.defaultBackend === 'local' && !p.departmentId;
  const assertCurrent = (current: () => boolean) => { if (!current()) throw new Error('account_changed'); };
  return {
    connect: async (installationId: string, currentProfileId: string | undefined, signal: AbortSignal, current: () => boolean, resetMissing = false): Promise<string> => {
      if (!/^[a-f0-9-]{36}$/.test(installationId)) throw new Error('invalid_request');
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${deps.userId}:${installationId}`));
      const suffix = `(${Array.from(new Uint8Array(bytes)).slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('')})`;
      const key = `brian:extension-browser:${deps.workspaceId}:${deps.userId}:${installationId}`;
      const savedId = deps.storage.getItem(key);
      let profiles = await deps.list(); assertCurrent(current);
      let profile = savedId ? profiles.find(p => p.id === savedId) : profiles.find(p => owned(p) && p.name.endsWith(suffix));
      if (savedId && !owned(profile)) {
        if (profile || !resetMissing) throw new Error('browser_identity_changed');
        profile = profiles.find(p => owned(p) && p.name.endsWith(suffix));
      }
      if (!profile) {
        profile = await deps.create(`${deps.label} ${suffix}`) ?? undefined; assertCurrent(current);
        // Concurrent app tabs converge via the existing unique workspace/name key.
        if (!profile) { profiles = await deps.list(); assertCurrent(current); profile = profiles.find(p => owned(p) && p.name.endsWith(suffix)); }
      }
      if (!owned(profile)) throw new Error('browser_identity_changed');
      deps.storage.setItem(key, profile.id);
      if (profile.id !== currentProfileId) {
        const status = await deps.status(profile.id); assertCurrent(current);
        if (!status.configured || status.connected) throw new Error('browser_connection_busy');
        if (!await deps.pair(profile.id, signal, current)) throw new Error('browser_connect_failed');
        assertCurrent(current);
      }
      managedId = profile.id;
      return profile.id;
    },
    prepare: async (profileId: string, assistantId: string, current: () => boolean) => {
      assertCurrent(current);
      if (!managedId || managedId !== profileId) throw new Error('browser_identity_changed');
      const profile = (await deps.list()).find(p => p.id === profileId); assertCurrent(current);
      if (!owned(profile)) throw new Error('browser_identity_changed');
      if (!profile.enabledAssistantIds.includes(assistantId)) {
        if (!await deps.enable(profile.id, [...profile.enabledAssistantIds, assistantId])) throw new Error('browser_identity_changed');
        assertCurrent(current);
      }
    },
  };
}
