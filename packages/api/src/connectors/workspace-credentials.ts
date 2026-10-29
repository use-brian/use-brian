/** Shared OSS/hosted workspace credential contract. [COMP:api/connector-instances-route] */
import { z } from 'zod'
import type { ConnectorCredentials, OAuthCredentials } from '../db/connector-store.js'
const secret = z.string().min(1).max(8192).refine(value => !/[\r\n]/.test(value))
export const workspaceCredentialsBody = z.union([
  z.object({ authType: z.literal('bearer'), bearerToken: secret }).strict(),
  z.object({ clientSecret: z.string().min(8).max(4096).refine(value => !/[\r\n]/.test(value)), clientId: z.string().max(256).refine(value => !/[\r\n]/.test(value)).optional() }).strict(),
])
export function workspaceCredentials(body: z.infer<typeof workspaceCredentialsBody>, custom: boolean): ConnectorCredentials | OAuthCredentials | null {
  if ('authType' in body) return custom ? { type: 'bearer', token: body.bearerToken } : null
  return custom ? null : { client_id: body.clientId ?? '', client_secret: body.clientSecret }
}
