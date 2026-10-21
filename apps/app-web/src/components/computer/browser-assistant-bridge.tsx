"use client";

import { useEffect, useRef } from 'react';
import { readChatAppearance } from '@use-brian/chat-ui';
import { authFetch, getAccessToken } from '@/lib/auth-fetch';
import { listWorkspaceAssistants } from '@/lib/api/views';
import { listBrowserProfiles, pairBrowserExtension } from '@/lib/api/computer';
import { publicRuntimeConfig } from '@/lib/runtime-public-config';
import { useWorkspaceContext } from '@/lib/workspace-context';
import { getUserInfo } from '@/lib/user';
import { fetchWorkspaces, useWorkspaceFetch, useWorkspaces, updateWorkspace } from '@/contexts/workspace-context';
import { updateWorkspacePickerPreferences } from '@/lib/api/workspaces';
import { useT } from '@/lib/i18n/client';
import { getAccountsDir } from '@/lib/accounts';
import { primaryAuthUrl } from '@/lib/primary-auth';
import { resetSurfaceCache } from '@/lib/surface-cache';
import { chromeMessenger, pairViaExtension } from '@/lib/browser-extension-bridge';
import { serveBrowserAssistant, type AssistantPort } from '@/lib/browser-assistant-transport';

/** First-party authenticated transport for the extension side panel. */
export function BrowserAssistantBridge() {
  const { workspaceId, name, me } = useWorkspaceContext();
  const { workspaces } = useWorkspaces();
  const workspaceRows = useRef(workspaces); workspaceRows.current = workspaces;
  useWorkspaceFetch(publicRuntimeConfig().apiUrl);
  const pickerLabels = useT().workspaceSwitcher;
  useEffect(() => {
    const runtime = (globalThis as { chrome?: { runtime?: { connect?: (id: string, options: { name: string }) => AssistantPort; lastError?: unknown } } }).chrome?.runtime;
    const config = publicRuntimeConfig();
    if (!runtime?.connect || !config.browserExtensionId || !me.id) return;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let port: AssistantPort | undefined;
    let service: ReturnType<typeof serveBrowserAssistant> | undefined;
    let appearanceFrame: number | undefined;
    const appearanceObserver = new MutationObserver(() => {
      if (appearanceFrame !== undefined) return;
      appearanceFrame = requestAnimationFrame(() => { appearanceFrame = undefined; service?.publishAppearance(); });
    });
    appearanceObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-palette'] });
    appearanceObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
    const isCurrentUser = () => {
      const token = getAccessToken();
      try { return JSON.parse(atob(token!.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub === me.id; }
      catch { return false; }
    };
    function connect() {
      if (closed || !getAccessToken()) return;
      try {
        port = runtime!.connect!(config.browserExtensionId, { name: 'brian-assistant-chat' });
        service = serveBrowserAssistant(port, {
          apiUrl: config.apiUrl || 'http://localhost:4000', workspaceId, workspaceName: name, userId: me.id,
          isCurrentUser,
          appearance: () => readChatAppearance(document.documentElement),
          pickerLabels: () => ({ searchPlaceholder: pickerLabels.searchPlaceholder, empty: pickerLabels.empty, addAnotherAccount: pickerLabels.addAnotherAccount, switchAccountAria: pickerLabels.switchAccountAria, switcherAriaLabel: pickerLabels.switcherAriaLabel }),
          workspaceManagement: {
            directory: async () => workspaceRows.current.length ? workspaceRows.current : fetchWorkspaces(config.apiUrl),
            list: () => fetchWorkspaces(config.apiUrl),
            select: id => {
              if (!isCurrentUser()) return;
              updateWorkspace(id, { pickerLastOpenedAt: new Date().toISOString() });
              void updateWorkspacePickerPreferences(id, { opened: true }).catch(() => undefined);
              window.location.assign(`/w/${encodeURIComponent(id)}`);
            },
          },
          accountManagement: {
            directory: () => {
              const user = getUserInfo();
              const current = { id: me.id!, name: user?.name ?? "", email: user?.email ?? "", ...(user?.avatarUrl ? { avatarUrl: user.avatarUrl } : {}) };
              const accounts = getAccountsDir().filter(a => a.id !== current.id).slice(0, 7);
              return { current, canManageAccounts: !!primaryAuthUrl(), accounts: [current, ...accounts].map(({ id, name, email, avatarUrl }) => ({ id, name, email, ...(avatarUrl ? { avatarUrl } : {}) })) };
            },
            act: (action: 'add' | 'switch', accountId?: string) => {
              if (!isCurrentUser() || !primaryAuthUrl()) return;
              resetSurfaceCache();
              const url = new URL(action === 'add' ? '/login' : '/api/auth/switch-account-and-return', primaryAuthUrl()!);
              if (action === 'add') url.searchParams.set('addAccount', '1');
              else url.searchParams.set('accountId', accountId!);
              url.searchParams.set('next', `${window.location.origin}/`);
              window.location.assign(url.toString());
            },
            profiles: async () => (await listBrowserProfiles(workspaceId)).profiles,
            pair: async (profileId: string, signal: AbortSignal, current: () => boolean) => {
              if (!current() || !isCurrentUser()) return false;
              const pairing = await pairBrowserExtension(workspaceId, profileId, signal);
              if (!pairing || !current() || !isCurrentUser()) return false;
              return await pairViaExtension({ extensionId: config.browserExtensionId, relayUrl: pairing.relayUrl, pairingToken: pairing.pairingToken, send: chromeMessenger() }) === 'paired';
            },
            openBrowsers: () => { if (isCurrentUser()) window.location.assign(`/w/${encodeURIComponent(workspaceId)}/computer/profiles`); },
          },
          fetch: async (url, init) => {
            // A second account can sign in without remounting this layout.
            // Never let a stale workspace port adopt that account's cookies.
            if (!isCurrentUser()) throw new Error('account_changed');
            return authFetch(url, init);
          },
          assistants: () => listWorkspaceAssistants(workspaceId),
          profile: async id => (await listBrowserProfiles(workspaceId)).profiles.find(p => p.id === id) ?? null,
        });
        const publish = () => { void service?.hello().catch(() => undefined); };
        publish(); heartbeat = setInterval(publish, 20_000);
        port.onDisconnect.addListener(() => {
          void runtime!.lastError; service?.dispose(); clearInterval(heartbeat);
          if (!closed) retry = setTimeout(connect, 10_000);
        });
      } catch { if (!closed) retry = setTimeout(connect, 10_000); }
    }
    connect();
    return () => { closed = true; clearTimeout(retry); clearInterval(heartbeat); appearanceObserver.disconnect();
      if (appearanceFrame !== undefined) cancelAnimationFrame(appearanceFrame);
      service?.dispose(); port?.disconnect(); };
  }, [workspaceId, name, me.id, pickerLabels]);
  return null;
}
