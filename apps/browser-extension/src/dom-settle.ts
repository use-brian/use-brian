/** Serialized into the page. No animation frames: those pause in background tabs. */
export function waitForDomQuiet(quietMs: number, maxMs: number): Promise<void> {
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
    try {
      observer = new MutationObserver(() => {
        clearTimeout(quietTimer)
        quietTimer = setTimeout(finish, quietMs)
      })
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
      quietTimer = setTimeout(finish, quietMs)
      deadlineTimer = setTimeout(finish, maxMs)
    } catch {
      finish()
    }
  })
}

/** Host-side deadline also covers suspended/throttled page timers and CDP errors. */
export async function settleBeforeSnapshot(evaluate: (expression: string) => Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(() => evaluate(`(${waitForDomQuiet.toString()})(100, 750)`)).catch(() => undefined),
      new Promise<void>(resolve => { timer = setTimeout(resolve, 750) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
