import { it,expect,vi } from 'vitest'
import { signNativeToken,verifyNativeToken } from '../native-computer-token.js'
import { signBrowserExtPairToken,verifyBrowserExtHelloToken } from '../browser-ext-pair-token.js'
it('separates native and browser audiences, rejects tampering and expiry',()=>{
 vi.useFakeTimers();const claims={aud:'native-computer-v1' as const,kind:'native-session' as const,identity:{deploymentId:'d',userId:'u',workspaceId:'w',deviceId:'device',sessionId:'s',conversationId:'c',taskId:'t'},grantId:'g',epoch:0,exp:Date.now()+1000,jti:'00000000-0000-4000-8000-000000000000'}
 const token=signNativeToken(claims,'secret');expect(verifyNativeToken(token,'secret')).toEqual(claims);expect(verifyBrowserExtHelloToken(token,'secret')).toBeNull();expect(verifyNativeToken(signBrowserExtPairToken({userId:'u',workspaceId:'w',browserProfileId:'b'},'secret'),'secret')).toBeNull();expect(verifyNativeToken(token,'wrong')).toBeNull();vi.advanceTimersByTime(1001);expect(verifyNativeToken(token,'secret')).toBeNull();vi.useRealTimers()
})
