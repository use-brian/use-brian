// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
import { resetSurfaceCache } from '@/lib/surface-cache';
const api = vi.hoisted(() => ({ getChannelRecordings: vi.fn(), confirmRecordingOwner: vi.fn(), updateChannelRecording: vi.fn(), previewLegacyGroupRecovery: vi.fn(), restoreLegacyGroupContext: vi.fn() }));
const confirm = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/channels', () => api);
vi.mock('@/lib/api/context-scopes', () => ({ listContextProjects: vi.fn().mockResolvedValue([]) }));
vi.mock('@/components/ui/confirm-dialog', () => ({ confirmDialog: confirm }));
vi.mock('@/components/ui/searchable-select', () => ({ SearchableSelect: ({ items, onValueChange }: { items: {value:string;label:string}[];onValueChange:(value:string)=>void }) => <div>{items.map(item => <button key={item.value} onClick={() => onValueChange(item.value)}>{item.label}</button>)}</div> }));
vi.mock('next/link', () => ({ default: ({ children, href }: {children:React.ReactNode;href:string}) => <a href={href}>{children}</a> }));
import { ChannelRecordingsPanel } from '../channel-recordings';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement,root:Root;
async function mount() { await act(async () => { root.render(<I18nProvider locale="en" dict={en}><ChannelRecordingsPanel workspaceId="workspace" channelId="channel" /></I18nProvider>); }); }
async function click(text:string) { const button = [...host.querySelectorAll('button')].find(b=>b.textContent===text)!; expect(button).toBeTruthy(); await act(async()=>{button.click();}); }
const candidate = {sessionId:'old-session',snapshotToken:'reviewed-token',conversationId:'group:topic:7',assistantId:'assistant',assistantName:'Assistant',title:'Team planning',messageCount:12,skippedMessageCount:3,sensitivity:'internal',compartments:['planning'],projectId:null,projectName:null};
describe('[COMP:app-web/channel-recordings] explicit recording choices',()=>{
  beforeEach(()=>{vi.clearAllMocks();resetSurfaceCache();host=document.createElement('div');document.body.append(host);root=createRoot(host);confirm.mockResolvedValue(true);});
  afterEach(async()=>{await act(async()=>root.unmount());host.remove();resetSurfaceCache();});
  it('requires confirmation for legacy ownership and does not show another owner’s recordings',async()=>{
    api.getChannelRecordings.mockResolvedValue({ownership:'needs_confirmation',recordings:[]});await mount();
    await click(en.channelRecordings.confirmOwner);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({description:en.channelRecordings.confirmOwnerHint}));
    expect(api.confirmRecordingOwner).toHaveBeenCalledWith('workspace','channel');
  });
  it('previews future-only Work sharing and submits the exact reviewed revision',async()=>{
    const row={id:'policy',conversationId:'group:topic:7',revision:4,enabled:true,destination:'personal',projectId:null,sessionId:'session'};
    api.getChannelRecordings.mockResolvedValue({ownership:'mine',recordings:[row]});await mount();
    await click(en.channelRecordings.general);await click(en.channelRecordings.save);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({description:expect.stringContaining('Earlier history will not move')}));
    expect(api.updateChannelRecording).toHaveBeenCalledWith('workspace','channel',row,{enabled:true,destination:'workspace',projectId:null});
  });

  it('loads only metadata on request and restores only the explicitly confirmed snapshot',async()=>{
    api.getChannelRecordings.mockResolvedValue({ownership:'needs_confirmation',recordings:[]});
    api.previewLegacyGroupRecovery.mockResolvedValue({candidates:[candidate]});
    api.restoreLegacyGroupContext.mockResolvedValue({sessionId:'new-session',policyId:'policy',revision:1});
    await mount(); expect(api.previewLegacyGroupRecovery).not.toHaveBeenCalled();
    await click(en.channelRecordings.reviewContext);
    expect(host.textContent).toContain('Team planning');expect(host.textContent).toContain('group:topic:7');
    expect(host.textContent).toContain('internal, planning');expect(api.restoreLegacyGroupContext).not.toHaveBeenCalled();
    confirm.mockResolvedValueOnce(false);await click(en.channelRecordings.restoreContext);
    expect(api.restoreLegacyGroupContext).not.toHaveBeenCalled();
    await click(en.channelRecordings.restoreContext);
    expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({description:expect.stringContaining('same original group')}));
    expect(api.restoreLegacyGroupContext).toHaveBeenCalledWith('workspace','channel',{sessionId:'old-session',snapshotToken:'reviewed-token'});
    expect(host.textContent).toContain(en.channelRecordings.contextRestored);
  });
  it('requires a new review after a stale or failed apply and never reports success',async()=>{
    api.getChannelRecordings.mockResolvedValue({ownership:'mine',recordings:[]});
    api.previewLegacyGroupRecovery.mockResolvedValue({candidates:[candidate]});
    api.restoreLegacyGroupContext.mockRejectedValue(new Error('stale'));
    await mount();await click(en.channelRecordings.reviewContext);await click(en.channelRecordings.restoreContext);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(en.channelRecordings.recoveryFailed);
    expect(host.textContent).not.toContain(en.channelRecordings.contextRestored);
    expect([...host.querySelectorAll('button')].some(b=>b.textContent===en.channelRecordings.restoreContext)).toBe(false);
    api.previewLegacyGroupRecovery.mockResolvedValue({candidates:[{...candidate,snapshotToken:'new-token'}]});
    await click(en.channelRecordings.reviewContext);await click(en.channelRecordings.restoreContext);
    expect(api.restoreLegacyGroupContext).toHaveBeenLastCalledWith('workspace','channel',{sessionId:'old-session',snapshotToken:'new-token'});
  });
  it('disables recovery controls while applying the reviewed snapshot',async()=>{
    api.getChannelRecordings.mockResolvedValue({ownership:'mine',recordings:[]});
    api.previewLegacyGroupRecovery.mockResolvedValue({candidates:[candidate]});
    let finish!:()=>void;
    api.restoreLegacyGroupContext.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
    await mount();await click(en.channelRecordings.reviewContext);await click(en.channelRecordings.restoreContext);
    for(const text of [en.channelRecordings.reviewContext,en.channelRecordings.restoreContext]) {
      expect([...host.querySelectorAll('button')].find(b=>b.textContent===text)?.disabled).toBe(true);
    }
    await act(async()=>finish());
    expect(host.textContent).toContain(en.channelRecordings.contextRestored);
  });
  it('can stop a recording after its Project is no longer available',async()=>{
    const row={id:'policy',conversationId:'group:topic:7',revision:5,enabled:true,destination:'workspace',projectId:'revoked-project',sessionId:'session'};
    api.getChannelRecordings.mockResolvedValue({ownership:'mine',recordings:[row]});await mount();
    await click(en.channelRecordings.stop);
    expect(api.updateChannelRecording).toHaveBeenCalledWith('workspace','channel',row,{enabled:false,destination:'workspace',projectId:'revoked-project'});
  });
});
