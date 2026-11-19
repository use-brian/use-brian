/** Bounded, ordered authorization for an already-open stream. [COMP:api/session-stream-authority] */
export function createSessionStreamAuthority(authorize: () => Promise<boolean>, close: (reason: 'denied' | 'unavailable') => void) {
  let disposed = false
  let pending = 0
  let tail = Promise.resolve()
  let deadline: NodeJS.Timeout | undefined
  const dispose = () => { disposed = true; if (deadline) clearTimeout(deadline) }
  const end = (reason: 'denied' | 'unavailable') => { if (!disposed) { dispose(); close(reason) } }
  return {
    dispose,
    run(send: () => void) {
      if (disposed) return
      if (++pending > 64) { end('unavailable'); return }
      tail = tail.then(async () => {
        if (disposed) return
        deadline = setTimeout(() => end('unavailable'), 5_000)
        deadline.unref?.()
        try {
          const allowed = await authorize()
          clearTimeout(deadline)
          if (disposed) return
          if (!allowed) { end('denied'); return }
          send()
        } catch { end('unavailable') }
        finally { pending-- }
      })
    },
  }
}
