// @vitest-environment jsdom
/**
 * [COMP:app-web/workspace-access] protected projection lifecycle. Pins why
 * Organization -> Departments stopped blanking to a skeleton: foreground entry
 * revalidates a projection that is still inside its deadline instead of
 * dropping it, and one projection's own expiry evicts only its own key, never
 * the sibling projections its key happens to prefix.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictSurfaceCacheKey, readSurfaceCache, resetSurfaceCache, seedSurfaceCache, useCachedResource } from '@/lib/surface-cache';
import { protectProjection, useProtectedProjection, type ProtectedProjection } from '@/lib/use-protected-projection';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Snapshot = { validForMs: number; label: string };
const KEY = 'workspace-access:ws-fixture:viewer-fixture';
const project = (label: string, validForMs = 30_000): ProtectedProjection<Snapshot> => protectProjection({ validForMs, label }, performance.now());

let host: HTMLDivElement, root: Root;
const seen: Array<string | null> = [];
const purge = vi.fn();
function Probe({ fetcher }: { fetcher: () => Promise<ProtectedProjection<Snapshot>> }) {
  const resource = useCachedResource(KEY, fetcher);
  const data = useProtectedProjection(KEY, resource.data, purge, resource.refresh);
  seen.push(data?.label ?? null);
  return <span>{data?.label ?? 'skeleton'}</span>;
}

beforeEach(() => {
  vi.useFakeTimers(); resetSurfaceCache(); seen.length = 0; purge.mockReset();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetSurfaceCache(); vi.useRealTimers(); });

describe('[COMP:app-web/workspace-access] protected projection lifecycle', () => {
  it('keeps a live projection painted on focus while the fresh one loads', async () => {
    seedSurfaceCache(KEY, project('first'));
    let resolve!: (value: ProtectedProjection<Snapshot>) => void;
    const fetcher = vi.fn(() => new Promise<ProtectedProjection<Snapshot>>(r => { resolve = r; }));
    await act(async () => root.render(<Probe fetcher={fetcher} />));
    expect(host.textContent).toBe('first');
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(host.textContent).toBe('first');
    expect(purge).not.toHaveBeenCalled();
    // Nothing blanked while the request was in flight. (A CHANGED projection
    // is then withheld for one render so selections clear first; that frame
    // is the identity contract, not a network wait.)
    expect(seen).not.toContain(null);
    await act(async () => { resolve(project('second')); });
    expect(host.textContent).toBe('second');
  });

  it('drops an expired projection on focus before refetching', async () => {
    seedSurfaceCache(KEY, project('stale', 2_000));
    const fetcher = vi.fn(() => new Promise<ProtectedProjection<Snapshot>>(() => {}));
    await act(async () => root.render(<Probe fetcher={fetcher} />));
    // Timers are frozen as if the tab slept: only the wall clock moved on.
    vi.setSystemTime(Date.now() + 5_000);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(purge).toHaveBeenCalled();
    expect(readSurfaceCache(KEY).data).toBeUndefined();
    expect(host.textContent).toBe('skeleton');
  });

  it('evicts exactly one key, leaving the projections it prefixes', () => {
    seedSurfaceCache(KEY, 'overview');
    seedSurfaceCache(`${KEY}:registry`, 'registry');
    seedSurfaceCache(`${KEY}:mode`, 'mode');
    evictSurfaceCacheKey(KEY);
    expect(readSurfaceCache(KEY).data).toBeUndefined();
    expect(readSurfaceCache(`${KEY}:registry`).data).toBe('registry');
    expect(readSurfaceCache(`${KEY}:mode`).data).toBe('mode');
  });
});
