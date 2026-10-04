import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'

// Inspect the actual listener options without importing server.ts, which starts
// workers and opens a listener as a module side effect.
it.each([undefined, '127.0.0.1', '::1'])('preserves optional doc-sync HOST %s without starting services', (host) => {
  const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
  const listener = source.match(/httpServer\.listen\((\{[^}]+\}),/)
  expect(listener).not.toBeNull()
  const options = runInNewContext(`(${listener![1]})`, {
    PORT: 8080, process: { env: { HOST: host } },
  })
  expect(options).toEqual({ port: 8080, host })
})
