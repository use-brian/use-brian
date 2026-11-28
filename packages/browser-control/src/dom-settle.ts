/** Serialized into the page. No animation frames: those pause in background tabs. */
export function waitForDomQuiet(quietMs: number, maxMs: number, afterClick = false): Promise<void> {
  return new Promise(resolve => {
    let observer: MutationObserver | undefined
    let quietTimer: ReturnType<typeof setTimeout> | undefined
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      observer?.disconnect()
      clearTimeout(quietTimer)
      clearTimeout(deadlineTimer)
      resolve()
    }
    // A quiet DOM can still be waiting for a fetch triggered by the click.
    // A visible busy region or short ongoing announcement is a hint, not
    // proof of completion; the deadline still wins if it never goes away.
    const finishIfReady = () => {
      if (afterClick) {
        for (const node of Array.from(document.querySelectorAll('[aria-busy="true"], [role="status"], [role="progressbar"], progress, [aria-live="polite"], [aria-live="assertive"]'))) {
          if (!node.getClientRects().length || getComputedStyle(node).visibility !== 'visible') continue
          if (node.getAttribute('aria-busy') === 'true') return
          if (node.tagName === 'PROGRESS') {
            const progress = node as HTMLProgressElement
            if (!progress.hasAttribute('value') || progress.value < progress.max) return
          }
          if (node.getAttribute('role') === 'progressbar') {
            const value = node.getAttribute('aria-valuenow')
            const max = node.getAttribute('aria-valuemax') ?? '100'
            if (value === null || Number(value) < Number(max)) return
          }
          const text = node.textContent?.trim() ?? ''
          if (text.length <= 100 && (/(?:\.{3}|…)$/u.test(text) || /^(?:loading|searching|checking availability|please wait)(?:\b|[.…])/iu.test(text))) return
        }
      }
      finish()
    }
    try {
      observer = new MutationObserver(() => {
        clearTimeout(quietTimer)
        quietTimer = setTimeout(finishIfReady, quietMs)
      })
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
      quietTimer = setTimeout(finishIfReady, quietMs)
      deadlineTimer = setTimeout(finish, maxMs)
    } catch {
      finish()
    }
  })
}

/** Host-side deadline also covers suspended/throttled page timers and CDP errors. */
export async function settleBeforeSnapshot(evaluate: (expression: string) => Promise<unknown>, afterClick = false): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(() => evaluate(`(${waitForDomQuiet.toString()})(100, 750, ${afterClick})`)).catch(() => undefined),
      new Promise<void>(resolve => { timer = setTimeout(resolve, 750) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
