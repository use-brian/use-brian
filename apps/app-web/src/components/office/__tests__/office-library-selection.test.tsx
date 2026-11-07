// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfficeLibrarySelectionBar, useOfficeLibrarySelection } from '../office-library-selection';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('[COMP:app-web/office-library-selection] Scoped bulk trash', () => {
  let host: HTMLDivElement, root: Root;
  let selection: ReturnType<typeof useOfficeLibrarySelection>;
  const trash = vi.fn(), refresh = vi.fn();
  function Harness({ scope = 'viewer:workspace:files', ids = ['a', 'b'], available = true, trashView = false }) {
    selection = useOfficeLibrarySelection(scope, ids, available, trash, refresh);
    return <I18nProvider locale="en" dict={en}><OfficeLibrarySelectionBar selection={selection} total={ids.length} trashView={trashView} itemNames={{ a: "Fictional file A", b: "Fictional template B" }} /></I18nProvider>;
  }
  async function render(props = {}) { await act(async () => root.render(<Harness {...props} />)); }
  beforeEach(() => { vi.clearAllMocks(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); });
  it('trashes all selected items once and retains only failures for retry', async () => {
    trash.mockImplementation(async (id: string) => { if (id === 'b') throw new Error('held'); });
    await render(); act(() => selection.selectAll(true));
    expect(host.textContent).toContain('2 selected');
    await act(async () => { await selection.moveToTrash(); });
    expect(trash.mock.calls).toEqual([['a', 'trash'], ['b', 'trash']]);
    expect(selection.selected).toEqual(['b']);
    expect(host.textContent).toContain(en.office.bulkTrashFailed);
    trash.mockResolvedValue({});
    await act(async () => { await selection.moveToTrash(); });
    expect(selection.selected).toEqual([]); expect(selection.failed).toBe(false); expect(refresh).toHaveBeenCalledTimes(2);
  });
  it('prevents duplicate mutations while a bulk operation is pending', async () => {
    let finish!: () => void; trash.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    await render({ ids: ['a'] }); act(() => selection.selectAll(true));
    let pending!: Promise<void>; act(() => { pending = selection.moveToTrash(); });
    await act(async () => { await selection.moveToTrash(); });
    expect(trash).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); await pending; });
  });
  it('clears selection on collection expiry, identity/filter changes and removed candidates', async () => {
    await render(); act(() => selection.selectAll(true));
    await render({ ids: ['b'] }); expect(selection.selected).toEqual(['b']);
    await render({ scope: 'other-viewer:workspace:files' }); expect(selection.selected).toEqual([]);
    act(() => selection.selectAll(true)); await render({ available: false }); expect(selection.selected).toEqual([]);
    await render(); expect(selection.selected).toEqual([]);
  });
  it('does not let an old completion clear a new viewer selection or show its error', async () => {
    let reject!: (cause: Error) => void; trash.mockImplementation(() => new Promise<void>((_, no) => { reject = no; }));
    await render({ ids: ['a'] }); act(() => selection.toggle('a', true));
    let pending!: Promise<void>; act(() => { pending = selection.moveToTrash(); });
    await render({ scope: 'viewer-b:workspace:files', ids: ['b'] }); act(() => selection.toggle('b', true));
    await act(async () => { reject(new Error('revoked')); await pending; });
    expect(selection.selected).toEqual(['b']); expect(selection.failed).toBe(false);
  });
  it('restores multiple selected Trash items and retains a failed item for retry', async () => {
    trash.mockImplementation(async (id: string) => { if (id === 'b') throw new Error('held'); });
    await render({ trashView: true }); act(() => selection.selectAll(true));
    const restore = [...host.querySelectorAll('button')].find(item => item.textContent === en.office.restore)!;
    await act(async () => restore.click());
    expect(trash.mock.calls).toEqual([['a', 'restore'], ['b', 'restore']]);
    expect(selection.selected).toEqual(['b']); expect(host.textContent).toContain(en.office.bulkRestoreFailed);
    expect(host.textContent).not.toContain(en.office.moveToTrash);
  });
  it('requires an exact confirmation before deleting the reviewed selection', async () => {
    trash.mockResolvedValue({}); await render({ trashView: true }); act(() => selection.selectAll(true));
    act(() => [...host.querySelectorAll('button')].find(item => item.textContent === en.office.deletePermanently)!.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Fictional file A');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Fictional template B');
    const submit = document.querySelector<HTMLButtonElement>('form button[type="submit"]')!;
    const input = document.querySelector<HTMLInputElement>('form input')!;
    expect(submit.disabled).toBe(true); expect(trash).not.toHaveBeenCalled();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, en.office.deletePermanently);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    expect(trash.mock.calls).toEqual([['a', 'purge'], ['b', 'purge']]); expect(selection.selected).toEqual([]);
  });
  it.each(['selection', 'viewer', 'expiry'])('invalidates a deletion confirmation after a change to %s', async change => {
    await render({ trashView: true }); act(() => selection.selectAll(true));
    act(() => [...host.querySelectorAll('button')].find(item => item.textContent === en.office.deletePermanently)!.click());
    if (change === 'selection') act(() => selection.toggle('b', false));
    else if (change === 'viewer') await render({ trashView: true, scope: 'viewer-b:workspace:trash' });
    else await render({ trashView: true, available: false });
    expect(document.querySelector('form')).toBeNull(); expect(trash).not.toHaveBeenCalled();
  });

});
