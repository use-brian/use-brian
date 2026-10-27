// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
import { resetSurfaceCache } from '@/lib/surface-cache';
const api = vi.hoisted(() => ({ getChannelRecordings: vi.fn(), confirmRecordingOwner: vi.fn(), updateChannelRecording: vi.fn() }));
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
  it('can stop a recording after its Project is no longer available',async()=>{
    const row={id:'policy',conversationId:'group:topic:7',revision:5,enabled:true,destination:'workspace',projectId:'revoked-project',sessionId:'session'};
    api.getChannelRecordings.mockResolvedValue({ownership:'mine',recordings:[row]});await mount();
    await click(en.channelRecordings.stop);
    expect(api.updateChannelRecording).toHaveBeenCalledWith('workspace','channel',row,{enabled:false,destination:'workspace',projectId:'revoked-project'});
  });
});
