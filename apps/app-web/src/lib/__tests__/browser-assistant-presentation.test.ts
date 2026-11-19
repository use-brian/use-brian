/**
 * [COMP:app-web/browser-assistant-transport] The extension port as a relay
 * presentation of the shared conversation controller (M5 WP-E), exercised
 * with scripted streams: Stop is the controller's compare-and-set Stop with
 * the original POST's `turnId` (the former Stop sent `{ sessionId }` only),
 * a send still in admission is fenced locally, a failed Stop ends the request
 * without a second Stop, a disconnect fails visibly without a resend, only the
 * allowlisted direct frames reach the panel, and the personal audience is
 * a typed request field on every send. Replaces the port's own SSE loop and abort
 * choreography. Spec: docs/architecture/engine/computer-use.md → "Shared
 * conversation controller (M5 WP-E, 2026-11-17)".
 */
import { describe, expect, it, vi } from 'vitest';
import { fakeSse, TURN_A, TURN_B, type FakeSse } from '@/lib/chat/__tests__/conversation-fakes';
import { serveBrowserAssistant, type AssistantPort } from '../browser-assistant-transport';

const request = { type: 'send' as const, id: 'request-1', text: 'Summarize this page', assistantId: 'assistant-1', browserProfileId: 'profile-1' };
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); };

function rig(options: { stop?: () => Promise<Response>; prepare?: () => Promise<void> } = {}) {
  const chats: Array<{ body: Record<string, unknown>; sse: FakeSse }> = [];
  const follows: FakeSse[] = [];
  const stops: Array<Record<string, unknown>> = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/chat')) {
      const sse = fakeSse(init?.signal);
      chats.push({ body: JSON.parse(String(init?.body)), sse });
      return sse.response;
    }
    if (url.endsWith('/api/chat/stop')) {
      stops.push(JSON.parse(String(init?.body)));
      return options.stop ? options.stop() : new Response('{"stopped":true}');
    }
    if (url.endsWith('/stream')) {
      const sse = fakeSse(init?.signal);
      follows.push(sse);
      return sse.response;
    }
    return new Response('{"status":"idle","turnId":null}');
  });
  let receive: (value: unknown) => void = () => {};
  let disconnect = () => {};
  const posted: Array<Record<string, unknown>> = [];
  const port: AssistantPort = {
    postMessage: message => { posted.push(message as Record<string, unknown>); },
    disconnect: vi.fn(),
    onMessage: { addListener: fn => { receive = fn; } },
    onDisconnect: { addListener: fn => { disconnect = fn; } },
  };
  const accountManagement = options.prepare ? {
    directory: () => ({ current: { id: 'user-1', name: 'Example', email: 'user@example.com' }, accounts: [] }),
    act: vi.fn(), profiles: vi.fn(async () => []), pair: vi.fn(async () => true), openBrowsers: vi.fn(),
    connect: vi.fn(async () => 'profile-1'), prepare: vi.fn(options.prepare),
  } : undefined;
  serveBrowserAssistant(port, {
    apiUrl: 'https://api.example.com', workspaceId: 'workspace-1', workspaceName: 'Example', userId: 'user-1', fetch,
    assistants: async () => [{ id: 'assistant-1', name: 'Assistant' }],
    profile: async () => ({ name: 'Work browser', ownerUserId: 'user-1', defaultBackend: 'local' }),
    ...(accountManagement ? { accountManagement } : {}),
  });
  const terminal = () => posted.filter(message => message.type === 'complete' || message.type === 'failure');
  const events = () => posted.filter(message => message.type === 'event').map(message => message.event);
  return { chats, follows, stops, fetch, posted, terminal, events, send: (value: unknown) => receive(value), closePort: () => disconnect() };
}

describe('[COMP:app-web/browser-assistant-transport] relay presentation of the conversation controller', () => {
  it('Stop names the original turn and keeps relaying until the stop is confirmed', async () => {
    let confirm: (value: Response) => void = () => {};
    const t = rig({ stop: () => new Promise(resolve => { confirm = resolve; }) });
    t.send(request); await settle();
    t.chats[0]!.sse.send('session', { sessionId: 'session-1', turnId: TURN_A });
    t.chats[0]!.sse.send('text_delta', { text: 'First' }); await settle();
    t.send({ type: 'stop', id: request.id }); await settle();
    expect(t.stops).toEqual([{ sessionId: 'session-1', turnId: TURN_A }]);
    // While the compare-and-set request is pending the direct stream still paints.
    t.chats[0]!.sse.send('text_delta', { text: ' second' }); await settle();
    expect(t.posted.filter(m => m.event === 'text_delta').map(m => (m.data as { text: string }).text)).toEqual(['First', ' second']);
    expect(t.terminal()).toEqual([]);
    confirm(new Response('{"stopped":true}')); await settle();
    expect(t.chats[0]!.sse.aborted()).toBe(true);
    expect(t.terminal()).toEqual([{ type: 'complete', id: request.id }]);
  });

  it('a Stop that arrives before the session frame waits for that exact turn', async () => {
    const t = rig();
    t.send(request); await settle();
    t.send({ type: 'stop', id: request.id }); await settle();
    expect(t.stops).toEqual([]);
    t.chats[0]!.sse.send('session', { sessionId: 'session-1', turnId: TURN_B }); await settle();
    expect(t.stops).toEqual([{ sessionId: 'session-1', turnId: TURN_B }]);
    expect(t.terminal()).toEqual([{ type: 'complete', id: request.id }]);
  });

  it('a Stop during admission never posts the turn', async () => {
    let release = () => {};
    const t = rig({ prepare: () => new Promise<void>(resolve => { release = resolve; }) });
    t.send({ type: 'browser-connect', id: 'connect-1', installationId: '10000000-0000-4000-8000-000000000001' }); await settle();
    t.send(request); await settle();
    t.send({ type: 'stop', id: request.id }); release(); await settle();
    expect(t.chats).toEqual([]);
    expect(t.stops).toEqual([]);
    expect(t.terminal()).toEqual([{ type: 'complete', id: request.id }]);
  });

  it('a failed Stop ends the request once and aborts the local stream without a second Stop', async () => {
    const t = rig({ stop: async () => new Response('{"error":"unavailable"}', { status: 503 }) });
    t.send(request); await settle();
    t.chats[0]!.sse.send('session', { sessionId: 'session-1', turnId: TURN_A }); await settle();
    t.send({ type: 'stop', id: request.id }); await settle();
    expect(t.stops).toHaveLength(1);
    expect(t.terminal()).toEqual([{ type: 'failure', id: request.id, code: 'stop_failed' }]);
    expect(t.chats[0]!.sse.aborted()).toBe(true);
    t.chats[0]!.sse.send('text_delta', { text: 'late' }); await settle();
    expect(t.events()).not.toContain('text_delta');
  });

  it('a disconnect fails the request visibly, never resends and never follows', async () => {
    const t = rig();
    t.send(request); await settle();
    t.chats[0]!.sse.send('session', { sessionId: 'session-1', turnId: TURN_A });
    t.chats[0]!.sse.send('text_delta', { text: 'Partial' }); await settle();
    t.chats[0]!.sse.close(); await settle();
    expect(t.terminal()).toEqual([{ type: 'failure', id: request.id, code: 'chat_unavailable' }]);
    expect(t.chats).toHaveLength(1);
    expect(t.stops).toEqual([]);
    // The controller's reconnect follow is disposed with it (transport abort, not Stop).
    expect(t.follows.every(follow => follow.aborted())).toBe(true);
  });

  it('relays only the allowlisted direct frames and completes after done', async () => {
    const t = rig();
    t.send(request); await settle();
    const sse = t.chats[0]!.sse;
    sse.send('session', { sessionId: 'session-1', turnId: TURN_A });
    sse.send('reasoning', { text: 'private work' });
    sse.send('status', { phase: 'research_detected' });
    sse.send('notice', { code: 'budget_downgraded' });
    sse.send('tool_start', { id: 'tool-1', name: 'browserSnapshot' });
    sse.send('text_delta', { text: 'Answer' });
    sse.send('done', { turnId: TURN_A }); sse.close(); await settle();
    expect(t.events()).toEqual(['session', 'tool_start', 'text_delta', 'done']);
    expect(JSON.stringify(t.posted)).not.toContain('private work');
    expect(t.terminal()).toEqual([{ type: 'complete', id: request.id }]);
  });

  it('pins the personal audience on every chat POST and reuses the conversation for its own session', async () => {
    const t = rig();
    t.send(request); await settle();
    expect(t.chats[0]!.body).toMatchObject({ sessionAudience: 'personal', appOrigin: 'chat', assistantId: 'assistant-1', workspaceId: 'workspace-1' });
    expect(t.chats[0]!.body).not.toHaveProperty('sessionId');
    t.chats[0]!.sse.send('session', { sessionId: 'session-1', turnId: TURN_A });
    t.chats[0]!.sse.send('done', { turnId: TURN_A }); t.chats[0]!.sse.close(); await settle();
    expect(t.terminal()).toEqual([{ type: 'complete', id: request.id }]);
    t.send({ ...request, id: 'request-2', sessionId: 'session-1' }); await settle();
    expect(t.chats[1]!.body).toMatchObject({ sessionId: 'session-1', sessionAudience: 'personal' });
    // The adopted conversation is reused: no hydrate re-attach for its own session.
    expect(t.follows).toHaveLength(0);
  });

  it('closing the port stops a running request through the same compare-and-set Stop', async () => {
    const t = rig();
    t.send(request); await settle();
    t.chats[0]!.sse.send('session', { sessionId: 'session-1', turnId: TURN_A }); await settle();
    t.closePort(); await settle();
    expect(t.stops).toEqual([{ sessionId: 'session-1', turnId: TURN_A }]);
    expect(t.chats[0]!.sse.aborted()).toBe(true);
  });
});
