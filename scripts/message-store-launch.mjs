import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Resolve the optional local chat archive child without touching process
 * state. Kept pure/injected enough for the launcher's discovery rules to be
 * tested without starting the product.
 *
 * [COMP:platform/local-message-store-lifecycle]
 */
export function resolveMessageStoreLaunch({ root, env, exists = existsSync }) {
  const explicitEnabled = env.BRIAN_MESSAGE_STORE_ENABLED
  if (explicitEnabled === '0' || explicitEnabled === 'false') {
    return { enabled: false, reason: 'disabled' }
  }

  const sourceDir = resolve(
    env.BRIAN_MESSAGE_STORE_DIR || join(root, '..', '..', 'brian-message-store'),
  )
  const explicitBin = env.BRIAN_MESSAGE_STORE_BIN
    ? resolve(env.BRIAN_MESSAGE_STORE_BIN)
    : null
  const checkoutBin = join(sourceDir, 'bin', 'brian-message-store')

  if (explicitBin) {
    if (!exists(explicitBin)) {
      throw new Error(`BRIAN_MESSAGE_STORE_BIN does not exist: ${explicitBin}`)
    }
    return { enabled: true, cmd: explicitBin, args: [], cwd: dirname(explicitBin), source: 'binary' }
  }
  if (exists(checkoutBin)) {
    return { enabled: true, cmd: checkoutBin, args: [], cwd: sourceDir, source: 'binary' }
  }
  if (exists(join(sourceDir, 'go.mod'))) {
    return {
      enabled: true,
      cmd: 'go',
      args: ['run', './cmd/brian-message-store'],
      cwd: sourceDir,
      source: 'source',
    }
  }
  if (explicitEnabled === '1' || explicitEnabled === 'true') {
    throw new Error(
      `BRIAN_MESSAGE_STORE_ENABLED is set, but no binary or Go checkout was found at ${sourceDir}`,
    )
  }
  return { enabled: false, reason: 'not_found', sourceDir }
}
