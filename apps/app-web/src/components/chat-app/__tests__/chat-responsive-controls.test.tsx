// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { CreationContext } from "@/components/context/mode-aware-context";
import { ChatContextBar, useChatVisibleViewport } from "../chat-responsive-controls";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
describe("[COMP:app-web/chat-responsive-controls] narrow-pane controls", () => {
  let host: HTMLDivElement, root: Root, width: number;
  let observers: Array<() => void>;
  beforeEach(() => {
    width = 360; observers = [];
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 44, width, height: 44, top: 44, bottom: 88, left: 0, right: width, toJSON() {} }));
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { observers.push(callback); } observe() {} disconnect() {} unobserve() {} });
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  async function render(node: React.ReactNode) { await act(async () => root.render(<I18nProvider locale="en" dict={en}>{node}</I18nProvider>)); }
  async function click(element: HTMLElement) { await act(async () => element.click()); }
  async function resize(next: number) { await act(async () => { width = next; observers.forEach(observer => observer()); }); }
  function context(overrides: Partial<CreationContext> = {}): CreationContext {
    return {
      intent: 'private', ready: true, teamId: 'team-a', projectId: null, reviewNeeded: false,
      mode: { data: { mode: 'departments', setupState: 'ready' }, readySimple: false },
      choices: { teams: [{ id: 'team-a', name: 'Product team', status: 'active' }], projects: [] },
      selectTeam: vi.fn(), selectProject: vi.fn(), refresh: vi.fn(), review: vi.fn(),
      ...overrides,
    } as unknown as CreationContext;
  }

  it('summarizes the current context and preserves disabled pickers inside a focused sheet', async () => {
    const value = context(); await render(<ChatContextBar context={value} disabled />);
    const trigger = host.querySelector<HTMLButtonElement>('[data-chat-context-summary]')!;
    expect(trigger.textContent).toContain('Product team');
    expect(trigger.textContent).toContain(en.contextScope.addProject);
    expect(trigger.textContent).toContain(en.chatApp.viewPersonal);
    await click(trigger);
    expect(document.querySelector('[role=dialog]')).not.toBeNull();
    expect(document.querySelector('button[aria-label="Department"]')?.getAttribute('disabled')).not.toBeNull();
    expect(value.selectTeam).not.toHaveBeenCalled();
    await click(document.querySelector<HTMLButtonElement>(`button[aria-label="${en.chatApp.closePanel}"]`)!);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('surfaces review and incomplete context without making an unavailable context look selected', async () => {
    await render(<ChatContextBar context={context({ ready: false, reviewNeeded: true })} />);
    expect(host.textContent).toContain(en.chatApp.reviewContext);
    await render(<ChatContextBar context={context({ ready: false })} />);
    expect(host.textContent).toContain(en.chatApp.chooseContext);
  });

  it('keeps the desktop context row compact, explains it on demand, and retains optional project selection', async () => {
    width = 800;
    await render(<ChatContextBar context={context()} />);
    expect(host.textContent).toContain(en.chatApp.viewPersonal);
    expect(host.textContent).not.toContain(en.modeContext.private);
    expect(host.querySelector(`button[aria-label="${en.chatApp.contextSettingsTitle}"]`)).not.toBeNull();
    expect(host.querySelector(`button[aria-label="${en.contextScope.project}"]`)?.textContent).toContain(en.contextScope.addProject);
    expect(host.querySelector('[data-chat-scope-band]')?.className).not.toContain('bg-muted');
  });

  it('keeps the draft and input when resizing an open context sheet back to inline controls', async () => {
    const value = context();
    await render(<><textarea aria-label="Draft" defaultValue={"A multiline\ndraft"} /><ChatContextBar context={value} /></>);
    const input = host.querySelector('textarea')!;
    await click(host.querySelector<HTMLButtonElement>('[data-chat-context-summary]')!);
    expect(document.querySelector('[role=dialog]')).not.toBeNull();
    await resize(640);
    expect(host.querySelector('textarea')).toBe(input);
    expect(input.value).toBe('A multiline\ndraft');
    expect(document.querySelector('[role=dialog]')).toBeNull();
    expect(value.selectTeam).not.toHaveBeenCalled();
    expect(value.selectProject).not.toHaveBeenCalled();
  });

  it('clamps phone and tablet input to the keyboard viewport and cleans up when it closes', async () => {
    const viewport = new EventTarget() as EventTarget & { height: number; offsetTop: number };
    viewport.height = 400; viewport.offsetTop = 0;
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('innerWidth', 390); vi.stubGlobal('innerHeight', 844);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    function Pane() { const ref = useChatVisibleViewport(); return <div ref={ref} data-testid="pane"><textarea defaultValue="Keep this draft" /></div>; }
    await render(<Pane />);
    const pane = host.querySelector<HTMLElement>('[data-testid=pane]')!, input = pane.querySelector('textarea')!;
    expect(pane.style.getPropertyValue('--chat-visible-height')).toBe('356px');
    expect(pane.hasAttribute('data-chat-keyboard-constrained')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--chat-keyboard-inset')).toBe('444px');
    await act(async () => { vi.stubGlobal('innerWidth', 1024); window.dispatchEvent(new Event('resize')); });
    expect(pane.style.getPropertyValue('--chat-visible-height')).toBe('356px');
    await act(async () => { viewport.height = 844; viewport.dispatchEvent(new Event('resize')); });
    expect(pane.style.getPropertyValue('--chat-visible-height')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--chat-keyboard-inset')).toBe('');
    expect(pane.querySelector('textarea')).toBe(input);
    expect(input.value).toBe('Keep this draft');
  });
});
