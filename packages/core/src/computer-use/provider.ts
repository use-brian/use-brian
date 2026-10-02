import { NATIVE_PROTOCOL } from '@use-brian/computer-control/protocol.js'
import type { NativeComputerProvider } from './types.js'
export const unavailableNativeComputerProvider: NativeComputerProvider = {
  async status() {
    return { protocol: NATIVE_PROTOCOL, state: 'unavailable', epoch: 0, capabilities: {
      protocol: NATIVE_PROTOCOL, platform: 'unsupported', axRead: false, semanticActions: false, windowCapture: false, input: false,
      accessibilityPermission: 'unknown', capturePermission: 'unknown', limitations: ['Native computer provider not configured'],
    } }
  },
  async observe() { throw new Error('Native computer unavailable') },
  async execute(command) { return { commandId: command.commandId, outcome: 'not_executed', code: 'unsupported' } },
}
