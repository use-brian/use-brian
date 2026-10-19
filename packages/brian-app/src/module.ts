/** Server profile. Canonical registration is injected by the deployed Brian host. [COMP:shared/brian-app-sdk] */
import process from 'node:process'
import { ApplicationSdkError, appOAuthToken, httpTransport, type ApplicationTransport, type HttpTransportOptions } from './transport.js'
export type { ApplicationModuleDefinition, ApplicationOperationContext, ApplicationRegisteredOperation,
  ApplicationRegisteredCommand, defineApplicationModules } from '@use-brian/core'

/** A delegated user is always validated app-bound OAuth, never an arbitrary ID. */
export function createServiceTransport(options: HttpTransportOptions & {
  credential: () => Promise<{ kind: 'service'; token: string } | { kind: 'delegated'; token: string; userAuthorization: string }>
}): ApplicationTransport {
  if (!process.versions.node) throw new ApplicationSdkError('operation_not_available')
  return httpTransport(options, async (): Promise<Record<string,string>> => {
    const credential = await options.credential()
    if (!credential || !/^sk_app_[A-Za-z0-9_-]+$/.test(credential.token)) throw new ApplicationSdkError('authentication_required')
    if (credential.kind === 'service' && !('userAuthorization' in credential)) return { Authorization: `Bearer ${credential.token}` }
    if (credential.kind === 'delegated') return { Authorization: `Bearer ${credential.token}`,
      'X-UseBrian-User-Authorization': `Bearer ${appOAuthToken(credential.userAuthorization)}` }
    throw new ApplicationSdkError('authentication_required')
  })
}
