/**
 * What a "Connect" writes to extension storage.
 *
 * Pure, because the bug it fixes hid inside the service worker's message
 * handler: `configure` removed `sessionToken` unconditionally, so pressing
 * Connect without re-pasting a token logged a working extension out. The
 * popup's token field is blank every time it opens (it is cleared after a
 * successful connect and never repopulated), and Connect is exactly what a
 * user presses when the assistant says it cannot connect — so the recovery
 * action destroyed the pairing it was meant to repair.
 *
 * The rule: a NEW pairing token supersedes the session (it may belong to a
 * different account, so the old session must not outlive it); no token means
 * "reconnect with what I already have" and must preserve it.
 */

export type PairRequest = {
  relayUrl?: string | null
  pairingToken?: string | null
}

export type CredentialWrite = {
  /** Keys to write to `chrome.storage.local`. */
  set: Record<string, string>
  /** Keys to delete from `chrome.storage.local`. */
  remove: string[]
}

/** Trim and treat blank as absent — an empty input is not a value to store. */
function present(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Is this sender allowed to hand us a pairing token?
 *
 * `externally_connectable` already enforces this at the Chrome layer, so the
 * check is defence in depth — but it reads the manifest's own `matches` rather
 * than a second hardcoded list, because two lists that must agree eventually
 * will not, and the one that drifts would be the security boundary.
 *
 * Wildcard-subdomain patterns are deliberately NOT honoured: we do not use
 * them, and quietly supporting them would let a widened manifest grant every
 * subdomain the right to pair this extension to an account.
 */
export function isTrustedPairingOrigin(
  origin: string | null | undefined,
  matches: readonly string[],
): boolean {
  if (!origin) return false
  let sender: URL
  try {
    sender = new URL(origin)
  } catch {
    return false
  }
  return matches.some((pattern) => {
    const parsed = /^(https?):\/\/([^/*]+)\/\*$/.exec(pattern)
    if (!parsed) return false
    const [, scheme, host] = parsed
    // Port is intentionally ignored so any dev port on loopback works; the
    // host must match exactly, so no suffix or prefix confusion gets through.
    return sender.protocol === `${scheme}:` && sender.hostname.toLowerCase() === host.toLowerCase()
  })
}

export function credentialsForConfigure(req: PairRequest): CredentialWrite {
  const set: Record<string, string> = {}
  const remove: string[] = []

  const relayUrl = present(req.relayUrl)
  if (relayUrl) set.relayUrl = relayUrl

  const pairingToken = present(req.pairingToken)
  if (pairingToken) {
    set.pairingToken = pairingToken
    remove.push('sessionToken')
  }

  return { set, remove }
}
