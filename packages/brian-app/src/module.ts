/** Server profile. Canonical registration is injected by the deployed Brian host. [COMP:shared/brian-app-sdk] */
import process from 'node:process'
import { ApplicationSdkError, appIdentifier, appOAuthToken, httpTransport, type ApplicationFetch, type ApplicationTransport, type HttpTransportOptions } from './transport.js'
import type { ApplicationCallOptions, ApplicationSchemaPorts, ApplicationSchemaPreviewResult, ApplicationSchemaApplyResult } from './application.js'
export type { ApplicationModuleDefinition, ApplicationOperationContext, ApplicationRegisteredOperation,
  ApplicationRegisteredCommand, defineApplicationModules } from '@use-brian/core'

export function createNativeSchemaPorts(options: HttpTransportOptions & { workspaceId: string; fetch: ApplicationFetch }): ApplicationSchemaPorts {
  if (!process.versions.node || typeof options.fetch !== 'function') throw new ApplicationSdkError('operation_not_available')
  const workspaceId = appIdentifier(options.workspaceId), base = `/api/applications/workspaces/${workspaceId}`
  const transport = httpTransport(options, async () => ({}), 'workspace')
  return {
    async preview(input, call = {}) {
      if (call.signal?.aborted) throw new ApplicationSdkError('cancelled', 'none', false, undefined, true)
      const { typeId, ...body } = input
      return await transport({ appId: workspaceId, method: 'POST', path: `${base}/schemas/${appIdentifier(typeId)}/preview`,
        body, signal: call.signal, effectful: true }) as ApplicationSchemaPreviewResult
    },
    async apply(input, call = {}) {
      if (call.signal?.aborted) throw new ApplicationSdkError('cancelled', 'none', false, undefined, true)
      const { previewId, ...body } = input
      return await transport({ appId: workspaceId, method: 'POST', path: `${base}/schema-reviews/${appIdentifier(previewId)}/apply`,
        body, signal: call.signal, effectful: true }) as ApplicationSchemaApplyResult
    },
  }
}

/** A delegated user is always validated app-bound OAuth, never an arbitrary ID. */
export function createServiceTransport(options: HttpTransportOptions & {
  credential: (call?: ApplicationCallOptions) => Promise<{ kind: 'service'; token: string } | { kind: 'delegated'; token: string; userAuthorization: string }>
}): ApplicationTransport {
  if (!process.versions.node) throw new ApplicationSdkError('operation_not_available')
  return httpTransport(options, async (request): Promise<Record<string,string>> => {
    const credential = await options.credential({ signal: request.signal })
    if (!credential || !/^sk_app_[A-Za-z0-9_-]+$/.test(credential.token)) throw new ApplicationSdkError('authentication_required')
    if (credential.kind === 'service' && !('userAuthorization' in credential)) return { Authorization: `Bearer ${credential.token}` }
    if (credential.kind === 'delegated') return { Authorization: `Bearer ${credential.token}`,
      'X-UseBrian-User-Authorization': `Bearer ${appOAuthToken(credential.userAuthorization)}` }
    throw new ApplicationSdkError('authentication_required')
  })
}
