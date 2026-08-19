/** Minimal structured-ish logger; injectable so tests stay quiet. */
export type Logger = {
  info: (msg: string, ...rest: unknown[]) => void
  warn: (msg: string, ...rest: unknown[]) => void
  error: (msg: string, ...rest: unknown[]) => void
}

export const consoleLogger: Logger = {
  info: (msg, ...rest) => console.log(`[bridge] ${msg}`, ...rest),
  warn: (msg, ...rest) => console.warn(`[bridge] ${msg}`, ...rest),
  error: (msg, ...rest) => console.error(`[bridge] ${msg}`, ...rest),
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done() {
      signal?.removeEventListener('abort', done)
      clearTimeout(t)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
