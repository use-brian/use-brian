/** Application browser profile. Canonical wire imports are erased. [COMP:shared/brian-app-sdk] */
import type { ApplicationCommand, ApplicationJson, ApplicationModuleCatalog, ApplicationOperationReceipt,
  ApplicationQuery, ApplicationRecordProjection, ApplicationResourceDefinition } from '@use-brian/shared'
import { ApplicationSdkError, appIdentifier, appOAuthToken, httpTransport, type ApplicationTransport,
  type HttpTransportOptions } from './transport.js'
export { ApplicationSdkError } from './transport.js'
export type { ApplicationTransport, ApplicationRequest, ApplicationFetch, ApplicationSdkCode } from './transport.js'
export type { ApplicationCommand, ApplicationQuery, ApplicationRecordProjection, ApplicationResourceRef,
  ApplicationOperationReceipt, ApplicationResourceDefinition, ApplicationJson } from '@use-brian/shared'
export { createApplicationSignIn, createHomeApplicationTransport } from './sign-in.js'
export type { ApplicationSignInOptions, HomeApplicationOptions } from './sign-in.js'

export interface ApplicationCatalog extends Pick<ApplicationModuleCatalog, 'version' | 'resources' | 'queries' | 'commands'> {
  moduleKey: string
  operationSchemas: { queries: Record<string, unknown>; commands: Record<string, unknown> }
}
export interface ApplicationCallOptions { signal?: AbortSignal }
/** Deployment-owned ports until the canonical R2 route contract is frozen. No guessed URL. */
export interface ApplicationSchemaPorts {
  preview(input: ApplicationJson, options?: ApplicationCallOptions): Promise<unknown>
  apply(input: ApplicationCommand, options?: ApplicationCallOptions): Promise<unknown>
}
export function createFetchTransport(options: HttpTransportOptions & {
  credential: (appId: string) => Promise<string | null>
}): ApplicationTransport {
  return httpTransport(options, async request => ({ Authorization: `Bearer ${appOAuthToken(await options.credential(request.appId))}` }))
}
function segment(value: string): string {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\u0000-\u001f\u007f]/.test(value)) throw new ApplicationSdkError('invalid_value')
  return encodeURIComponent(value)
}
export function createApplicationClient(options: { appId: string; transport: ApplicationTransport; schemas?: ApplicationSchemaPorts }) {
  const base = `/api/applications/${appIdentifier(options.appId)}`
  const send = <T>(method: 'GET' | 'POST', path: string, body: unknown, call: ApplicationCallOptions = {}, effectful = false): Promise<T> => {
    if (call.signal?.aborted) return Promise.reject(new ApplicationSdkError('cancelled', 'none', false, undefined, true))
    return options.transport({ appId: options.appId, method, path: base + path, body, effectful, signal: call.signal }) as Promise<T>
  }
  return {
    catalog: (call?: ApplicationCallOptions) => send<ApplicationCatalog>('GET', '/catalog', undefined, call),
    schema: (type: string, call?: ApplicationCallOptions) => send<ApplicationResourceDefinition>('GET', `/schemas/${segment(type)}`, undefined, call),
    get: <T = ApplicationRecordProjection>(type: string, id: string, call?: ApplicationCallOptions) => send<T>('GET', `/records/${segment(type)}/${segment(id)}`, undefined, call),
    query: <T = ApplicationRecordProjection[]>(type: string, query: ApplicationQuery, call?: ApplicationCallOptions) => send<T>('POST', `/records/${segment(type)}/query`, query, call),
    history: <T = ApplicationRecordProjection[]>(type: string, id: string, beforeVersion?: string, call?: ApplicationCallOptions) =>
      send<T>('GET', `/records/${segment(type)}/${segment(id)}/history${beforeVersion === undefined ? '' : `?beforeVersion=${encodeURIComponent(beforeVersion)}`}`, undefined, call),
    registeredQuery: <T = unknown>(key: string, input: ApplicationJson, call?: ApplicationCallOptions) => send<T>('POST', `/queries/${segment(key)}`, input, call),
    command: <T = ApplicationOperationReceipt>(key: string, command: ApplicationCommand, call?: ApplicationCallOptions) => send<T>('POST', `/commands/${segment(key)}`, command, call, true),
    previewSchema: (input: ApplicationJson, call?: ApplicationCallOptions) => options.schemas ? options.schemas.preview(input, call) : Promise.reject(new ApplicationSdkError('operation_not_available')),
    applySchema: (input: ApplicationCommand, call?: ApplicationCallOptions) => options.schemas ? options.schemas.apply(input, call) : Promise.reject(new ApplicationSdkError('operation_not_available')),
  }
}
export type ApplicationClient = ReturnType<typeof createApplicationClient>
