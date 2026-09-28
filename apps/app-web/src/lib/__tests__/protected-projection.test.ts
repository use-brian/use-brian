import { afterEach, describe, expect, it, vi } from 'vitest';
import { protectProjection } from '../use-protected-projection';
import { SurfaceCacheEvictionError } from '../surface-cache';

describe('[COMP:app-web/workspace-access] projection deadlines',()=>{
  afterEach(()=>vi.restoreAllMocks());
  it('subtracts round-trip time and ignores the server clock offset',()=>{
    vi.spyOn(performance,'now').mockReturnValue(600);
    vi.spyOn(Date,'now').mockReturnValue(42_000);
    expect(protectProjection({validForMs:2_000},100)).toEqual({validForMs:2_000,projectionDeadline:43_500,projectionMonotonicDeadline:2_100});
  });
  it.each([undefined,NaN,0,-1,100])('refuses missing or exhausted lifetime %s',validForMs=>{
    vi.spyOn(performance,'now').mockReturnValue(200);
    expect(()=>protectProjection({validForMs:validForMs as number},100)).toThrow(SurfaceCacheEvictionError);
  });
  it('caps projection lifetime even if an older server returns an excessive TTL',()=>{
    vi.spyOn(performance,'now').mockReturnValue(100);
    expect(protectProjection({validForMs:3_000_000},100).projectionMonotonicDeadline).toBe(30_100);
  });
});
