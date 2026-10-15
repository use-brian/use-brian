// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeldMemoriesNotice } from '../held-memories-notice';
import { I18nProvider } from '@/lib/i18n/client';
import { format } from '@/lib/i18n/format';
import { en } from '@/lib/i18n/dictionaries/en';
import { ja } from '@/lib/i18n/dictionaries/ja';
import { zh } from '@/lib/i18n/dictionaries/zh';
import { zhCN } from '@/lib/i18n/dictionaries/zh-cn';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const mocks=vi.hoisted(()=>({summary:vi.fn(),request:vi.fn()}));
vi.mock('@/lib/api/workspace-access',()=>({fetchHeldMemorySummary:mocks.summary,requestHeldMemoryReview:mocks.request}));
const t=en.brainPage.heldMemories;
let root:Root,host:HTMLDivElement;
async function render(){await act(async()=>root.render(<I18nProvider locale="en" dict={en}><HeldMemoriesNotice workspaceId="workspace-one"/></I18nProvider>));}
const button=()=>host.querySelector<HTMLButtonElement>('button');
beforeEach(()=>{mocks.summary.mockReset();mocks.request.mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});

describe('[COMP:app-web/held-memories-notice] member view of hidden memories',()=>{
  it('renders nothing when no memory is held',async()=>{
    mocks.summary.mockResolvedValue({count:0,requestedAt:null});await render();
    expect(host.textContent).toBe('');expect(mocks.summary).toHaveBeenCalledWith('workspace-one');
  })
  it('shows only a count and requests review once',async()=>{
    mocks.summary.mockResolvedValue({count:3,requestedAt:null});mocks.request.mockResolvedValue({count:3,requestedAt:'2026-10-13T00:00:00.000Z'});
    await render();
    expect(host.textContent).toContain(format(t.notice,{count:3}));expect(button()!.textContent).toBe(t.request);expect(button()!.disabled).toBe(false);
    await act(async()=>button()!.click());
    expect(mocks.request).toHaveBeenCalledWith('workspace-one');expect(button()!.textContent).toBe(t.requested);expect(button()!.disabled).toBe(true);
  })
  it('shows an already open request as requested',async()=>{
    mocks.summary.mockResolvedValue({count:1,requestedAt:'2026-10-13T00:00:00.000Z'});await render();
    expect(host.textContent).toContain(t.noticeOne);expect(button()!.disabled).toBe(true);expect(button()!.textContent).toBe(t.requested);
  })
  it('hides the notice when nothing is left to review',async()=>{
    mocks.summary.mockResolvedValue({count:2,requestedAt:null});mocks.request.mockRejectedValue(new Error('nothing_held'));
    await render();await act(async()=>button()!.click());expect(host.textContent).toBe('');
  })
  it('keeps all locales complete and free of em dashes',()=>{
    for(const dict of [en,ja,zh,zhCN]){expect(Object.keys(dict.brainPage.heldMemories).sort()).toEqual(Object.keys(t).sort());expect(JSON.stringify(dict.brainPage.heldMemories)).not.toContain('—');}
  })
})
