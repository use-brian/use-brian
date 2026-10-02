import { StatusSchema, type NativeCommand, type NativeStatus } from '@use-brian/computer-control/protocol.js'
import type { NativeComputerService, NativeScope } from './service.js'
/** Structural implementation of core NativeComputerProvider. Scope/session are
 * selected by authenticated composition, never passed through model arguments. */
export function createRelayNativeComputerProvider(service: NativeComputerService, scope: NativeScope, sessionId: string) {
  async function execute(command: NativeCommand, signal: AbortSignal) {
    signal.throwIfAborted()
    if (command.identity.sessionId !== sessionId) throw new Error('Wrong native session')
    const abort = () => { void service.revoke(sessionId,scope.userId).catch(() => {}) }
    signal.addEventListener('abort',abort,{once:true})
    try { return await service.dispatch(scope,command) }
    finally { signal.removeEventListener('abort',abort) }
  }
  return {
    async status(signal: AbortSignal): Promise<NativeStatus> {
      signal.throwIfAborted()
      const status = await service.status(sessionId,scope.userId)
      const relay = status.relay as { status?: unknown }
      return StatusSchema.parse(relay.status)
    },
    execute,
    async observe(command: NativeCommand, signal: AbortSignal) {
      if (command.action.kind !== 'observe' && command.action.kind !== 'capture') throw new Error('Not an observation command')
      const receipt = await execute(command,signal)
      if (receipt.outcome !== 'executed' || !receipt.observation) throw new Error('Native observation unavailable')
      return receipt.observation
    },
  }
}
