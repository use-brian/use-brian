// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

const html = readFileSync(`${process.cwd()}/static-firefox/allow.html`, 'utf8')

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function openPrompt(search: string) {
  vi.resetModules()
  document.documentElement.innerHTML = html
  vi.stubGlobal('location', new URL(`moz-extension://fixture/allow.html${search}`))
  const sendMessage = vi.fn(async (_message: unknown) => ({ ok: true }))
  vi.stubGlobal('browser', { runtime: { sendMessage } })
  const close = vi.spyOn(window, 'close').mockImplementation(() => {})
  await import('../firefox-allow.js')
  return { sendMessage, close }
}

const tick = async () => { for (let index = 0; index < 8; index++) await Promise.resolve() }

describe('[COMP:ext/firefox-agent] actual Firefox Allow page identity', () => {
  it.each(['allow', 'deny'] as const)('carries its own URL identity on %s', async choice => {
    const { sendMessage, close } = await openPrompt('?host=alpha.example&promptId=fixture-prompt-a')
    expect(document.getElementById('detail')?.textContent).toContain('alpha.example')
    document.getElementById(choice)!.click()
    await tick()
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
      type: 'consent-response', allowed: choice === 'allow', promptId: 'fixture-prompt-a',
    })
    expect(close).toHaveBeenCalledOnce()
  })

  it.each(['allow', 'deny'] as const)('does not send %s without a prompt identity', async choice => {
    const { sendMessage } = await openPrompt('?host=alpha.example')
    document.getElementById(choice)!.click()
    await tick()
    expect(sendMessage).not.toHaveBeenCalled()
  })
})
