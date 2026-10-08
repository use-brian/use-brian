/** Bounded, ordered authorization for an already-open stream. [COMP:api/session-stream-authority] */
export function createSessionStreamAuthority(authorize: () => Promise<boolean>, close: () => void) {
  let disposed = false
  let pending = 0
  let tail = Promise.resolve()
  let deadline: NodeJS.Timeout | undefined
  const dispose = () => { disposed = true; if (deadline) clearTimeout(deadline) }
  const deny = () => { if (!disposed) { dispose(); close() } }
  return {
    dispose,
    run(send: () => void) {
      if (disposed) return
      if (++pending > 64) { deny(); return }
      tail = tail.then(async () => {
        if (disposed) return
        deadline = setTimeout(deny, 5_000)
        deadline.unref?.()
        try {
          const allowed = await authorize()
          clearTimeout(deadline)
          if (disposed) return
          if (!allowed) { deny(); return }
          send()
        } catch { deny() }
        finally { pending-- }
      })
    },
  }
}
