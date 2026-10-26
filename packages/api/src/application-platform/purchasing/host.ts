/** Trusted package-shipped factory for the explicit administrative reference host. [COMP:examples/application-references] */
import {applicationJsonSchema,ApplicationPlatformError} from '@use-brian/shared'
import {createCanonicalGenericApplicationModule} from '../generic-adapter.js'
import {canonicalGenericResource} from '../generic-reader.js'
import {assertApplicationModuleRole,lockApplicationModuleRecords} from '../module-runtime.js'
import {createWorkspacePurchaseOperationsModule} from './module.js'
import {resolvePurchaseSchemaIds} from './configuration.js'
export function createDeployedPurchaseModule(){return createWorkspacePurchaseOperationsModule({
 genericModule:createCanonicalGenericApplicationModule(),resourceForSchema:canonicalGenericResource,jsonInput:applicationJsonSchema,
 error:(code,message)=>new ApplicationPlatformError(code,message),
 resolveSchemaIds:context=>resolvePurchaseSchemaIds(context,()=>new ApplicationPlatformError('access_unavailable','The module configuration is unavailable.')),
 authorizeRole:(context,role)=>assertApplicationModuleRole(context,'purchasing',role),
 lockRecords:(context,ids)=>lockApplicationModuleRecords(context,'purchasing',ids),
})}
