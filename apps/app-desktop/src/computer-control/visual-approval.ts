import { isDeepStrictEqual } from 'node:util'
import { VisualApprovalSchema, type NativeCommand, type NativeVisualApproval } from './contracts.js'

export function freezeBinding(value: unknown, command: NativeCommand): NativeVisualApproval {
  const binding = VisualApprovalSchema.parse(value)
  const action = command.action
  if (action.kind !== 'visualInvoke' || binding.commandId !== command.commandId || binding.frameId !== action.frameId ||
    binding.action.observationId !== action.observationId || !isDeepStrictEqual(binding.action.target, action.target)) {
    throw new Error('Unbound visual approval')
  }
  Object.freeze(binding.action.target)
  Object.freeze(binding.action)
  return Object.freeze(binding)
}
