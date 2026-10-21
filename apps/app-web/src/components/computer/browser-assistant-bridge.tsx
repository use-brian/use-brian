"use client";

import { useEffect } from 'react';
import { readChatAppearance } from '@use-brian/chat-ui';
import { authFetch, getAccessToken } from '@/lib/auth-fetch';
import { listWorkspaceAssistants } from '@/lib/api/views';
import { listBrowserProfiles } from '@/lib/api/computer';
import { publicRuntimeConfig } from '@/lib/runtime-public-config';
import { useWorkspaceContext } from '@/lib/workspace-context';
import { serveBrowserAssistant, type AssistantPort } from '@/lib/browser-assistant-transport';

/** First-party authenticated transport for the extension side panel. */
export function BrowserAssistantBridge() {
  const { workspaceId, name, me } = useWorkspaceContext();
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
  }, [workspaceId, name, me.id]);
  return null;
}
