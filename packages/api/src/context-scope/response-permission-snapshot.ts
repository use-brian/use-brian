/** Compatibility exports for existing delivery-admission callers.
 * New request hosts use request-permission-context.ts. These aliases create an
 * internal delivery receipt, not a second permission loader or invalidation loop.
 */
export {
  createResponseDeliveryAdmission as createWebResponsePermissionSnapshot,
  ownsResponseDeliveryAdmission as ownsWebResponsePermissionSnapshot,
  type ResponseDeliveryAdmission as WebResponsePermissionSnapshot,
} from './response-delivery-admission.js'
