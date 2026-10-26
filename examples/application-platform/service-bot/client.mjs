/** Trusted Node deployment only. [COMP:examples/application-references] */
import { createApplicationClient } from '@use-brian/brian-app/application'
import { createServiceTransport } from '@use-brian/brian-app/module'
export function createServiceBot({ appId, apiOrigin, credential, fetch }) {
  // A delegated supplier must return an independently obtained app-bound OAuth token.
  // There is deliberately no userId, role, native bearer or browser transport argument.
  return createApplicationClient({ appId, transport: createServiceTransport({ apiOrigin, fetch, credential }) })
}
export async function readServiceRecord(bot, { type, id, signal }) { return bot.get(type,id,{signal}) }
export async function approveServiceRequest(bot, { id, orderId, expectedVersion, idempotencyKey, signal }) {
  return bot.command('approve_order',{idempotencyKey,expectedVersion,input:{id,orderId}},{signal})
}
