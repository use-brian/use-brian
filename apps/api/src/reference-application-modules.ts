/** Fixed administrative reference composition; registration grants no authority.
 * [COMP:api/application-management]
 */
import type { BootOpenApiOptions } from '@use-brian/api/boot.js'
import { createDeployedPurchaseModule } from '@use-brian/api/application-platform/purchasing/host.js'
export const referenceApplicationModules: NonNullable<BootOpenApiOptions['applicationModules']> = Object.freeze([createDeployedPurchaseModule()])
