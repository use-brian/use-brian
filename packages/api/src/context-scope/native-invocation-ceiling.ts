/** [COMP:api/delivery-authority] A destination only narrows the SQL reader.
 * Anonymous destination grants describe an audience, never a SQL principal.
 * The original actor/grant remains authoritative; full destination validation
 * still runs separately on the unchanged recipient and complete source closure.
 */
import { intersectAccessCeilings, type AccessCeiling } from '@use-brian/core'

export function nativeInvocationReadCeiling(original: AccessCeiling, recipient: AccessCeiling): AccessCeiling {
  if (original.workspaceId !== recipient.workspaceId || recipient.userId !== '' && original.userId !== recipient.userId) {
    throw new Error('access_actor_mismatch')
  }
  const destination = intersectAccessCeilings(recipient, recipient)
  const { departmentRead, ...labels } = destination
  return intersectAccessCeilings(original, {
    ...labels, userId: original.userId, mutationCompartments: [], visibilityAssistantIds: original.visibilityAssistantIds,
    // Never relabel an anonymous recipient grant as the invocation actor's
    // grant. Restrict the ORIGINAL grant by immutable destination labels.
    ...(destination.userId !== '' && departmentRead ? { departmentRead } : {}),
  })
}
