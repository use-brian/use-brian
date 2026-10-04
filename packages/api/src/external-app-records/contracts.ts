import { z } from 'zod'
import { createHmac } from 'node:crypto'
export function sourceSignature(secret:string,workspaceId:string,sourceId:string,operation:string,correlationId:string,authorization:string,input:unknown):string {
 const canonical=(v:unknown):string=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>`${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`:JSON.stringify(v)
 return createHmac('sha256',secret).update(canonical([workspaceId,sourceId,operation,correlationId,authorization,input])).digest('hex')
}
const key = z.string().trim().min(1).max(200)
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const PublishInput = z.object({ externalId: key, version, kind: z.enum(['company', 'deal']), entityId: z.string().uuid().optional(), name: z.string().trim().min(1).max(500), companyId: z.string().uuid().optional(), facts: z.record(z.unknown()) }).strict()
export const ReconcileInput = z.object({ externalId: key }).strict()
export const ObserveInput = z.object({ externalId: key, providerVersion: version, facts: z.record(z.unknown()) }).strict()
export const AccessInput = z.object({ externalId: key, version, userId: z.string().uuid().nullable(), state: z.enum(['requested', 'active', 'revoked']), roles: z.array(key).max(50) }).strict()
export type Publication = z.infer<typeof PublishInput>
export type Observation = z.infer<typeof ObserveInput>
export type AppAccess = z.infer<typeof AccessInput>
export type Source = { workspaceId: string; sourceId: string; publisherUserIds: readonly string[]; observerUserIds: readonly string[]; appRoles: readonly string[]; signingSecret:string }
export type Context = { workspaceId: string; sourceId: string; userId: string; correlationId: string }
export class RecordsError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code) }
}
