/** [COMP:app-web/channel-recordings] Exact reviewed recovery wire boundary. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/auth-fetch',()=>({authFetch:vi.fn()}));
import { authFetch } from '@/lib/auth-fetch';
import { previewLegacyGroupRecovery, restoreLegacyGroupContext } from '../channels';
const fetch=vi.mocked(authFetch);
beforeEach(()=>vi.resetAllMocks());
describe('[COMP:app-web/channel-recordings] group context recovery SDK',()=>{
  it('loads metadata without applying and encodes the authenticated resource path',async()=>{
    fetch.mockResolvedValue(new Response(JSON.stringify({candidates:[]})));
    expect(await previewLegacyGroupRecovery('workspace/a','channel/b')).toEqual({candidates:[]});
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/workspace%2Fa/channels/channel%2Fb/recordings/legacy-recovery'));
  });
  it('submits the exact reviewed id and token with both explicit approvals',async()=>{
    fetch.mockResolvedValue(new Response(JSON.stringify({sessionId:'new-session',policyId:'policy',revision:1})));
    await restoreLegacyGroupContext('workspace','channel',{sessionId:'old-session',snapshotToken:'token'});
    expect(fetch).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({method:'POST',body:JSON.stringify({sessionId:'old-session',snapshotToken:'token',confirmConnectedByMe:true,confirmHistoryReview:true})}));
  });
  it('rejects stale and access failures rather than converting them into success',async()=>{
    for(const status of [403,409,503]) {
      fetch.mockResolvedValue(new Response('{}',{status}));
      await expect(restoreLegacyGroupContext('workspace','channel',{sessionId:'old-session',snapshotToken:'token'})).rejects.toMatchObject({status});
    }
  });
});
