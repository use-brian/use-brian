import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { IdentitySchema, NATIVE_PROTOCOL } from '@use-brian/computer-control/protocol.js'
const Claims = z.object({ aud: z.literal(NATIVE_PROTOCOL), kind: z.literal('native-session'), identity: IdentitySchema, grantId: z.string().min(1), epoch: z.number().int().nonnegative(), exp: z.number().int(), jti: z.string().uuid() }).strict()
export type NativeTokenClaims = z.infer<typeof Claims>
export function signNativeToken(claims: NativeTokenClaims, secret: string): string {
  const body = Buffer.from(JSON.stringify(Claims.parse(claims))).toString('base64url')
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}
export function verifyNativeToken(token: string, secret: string): NativeTokenClaims | null {
  try {
    if (token.length > 8192) return null
    const [body, sig, extra] = token.split('.')
    const expected = createHmac('sha256', secret).update(body).digest('base64url')
    if (extra || !sig || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
    const claims = Claims.parse(JSON.parse(Buffer.from(body, 'base64url').toString()))
    if (claims.exp <= Date.now() || claims.exp > Date.now() + 15 * 60_000) return null
    return claims
  } catch { return null }
}
