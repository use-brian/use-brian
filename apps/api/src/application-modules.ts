/** Source-owned normal composition; executable modules are never runtime settings.
 * [COMP:api/application-management]
 */
import type { BootOpenApiOptions } from '@use-brian/api/boot.js'
export const applicationModules: NonNullable<BootOpenApiOptions['applicationModules']> = Object.freeze([])

/** One fixed administrative reference, loaded only after finite argv validation. */
export async function resolveApplicationModules(argv: readonly string[]): Promise<NonNullable<BootOpenApiOptions['applicationModules']>> {
  if (!argv.includes('--reference-applications')) return applicationModules
  if (!argv.includes('--admin-only')) throw new Error('--reference-applications requires --admin-only')
  const { referenceApplicationModules } = await import('./reference-application-modules.js')
  return Object.freeze([...applicationModules, ...referenceApplicationModules])
}
