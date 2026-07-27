import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { CodexAccountClient, CodexLoginError } from '../auth.js'
import { CodexRpcClosedError, CodexRpcPeer } from '../rpc.js'

type Harness = {
  peer: CodexRpcPeer
  inbound: PassThrough
  outbound: Array<{ id?: number; method?: string; params?: unknown }>
}

function createHarness(): Harness {
  const inbound = new PassThrough()
  const output = new PassThrough()
  const outbound: Harness['outbound'] = []
  let buffered = ''
  output.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8')
    let newline = buffered.indexOf('\n')
    while (newline !== -1) {
      outbound.push(JSON.parse(buffered.slice(0, newline)))
      buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf('\n')
    }
  })
  return {
    peer: new CodexRpcPeer({ input: inbound, output }),
    inbound,
    outbound,
  }
}

async function waitForOutbound(harness: Harness, count: number): Promise<void> {
  await vi.waitFor(() => expect(harness.outbound).toHaveLength(count))
}

function respond(harness: Harness, requestIndex: number, result: unknown): void {
  const request = harness.outbound[requestIndex]
  harness.inbound.write(`${JSON.stringify({ id: request.id, result })}\n`)
}

describe('[COMP:providers/codex-auth] Codex-managed ChatGPT authentication', () => {
  it('returns masked ChatGPT account state without exposing the raw email', async () => {
    const harness = createHarness()
    const client = new CodexAccountClient(harness.peer)
    const status = client.readAccount()
    await waitForOutbound(harness, 1)
    expect(harness.outbound[0]).toMatchObject({
      method: 'account/read',
      params: { refreshToken: false },
    })
    respond(harness, 0, {
      account: { type: 'chatgpt', email: 'person@example.com', planType: 'plus' },
      requiresOpenaiAuth: true,
    })

    await expect(status).resolves.toEqual({
      connected: true,
      authType: 'chatgpt',
      planType: 'plus',
      emailHint: 'p***@example.com',
      requiresOpenaiAuth: true,
    })
    expect(JSON.stringify(await status)).not.toContain('person@example.com')
    client.close()
    harness.peer.close()
  })

  it('starts browser login only for an HTTPS OpenAI-owned origin', async () => {
    const harness = createHarness()
    const client = new CodexAccountClient(harness.peer)
    const login = client.startBrowserLogin()
    await waitForOutbound(harness, 1)
    expect(harness.outbound[0]).toMatchObject({
      method: 'account/login/start',
      params: {
        type: 'chatgpt',
        appBrand: 'chatgpt',
        useHostedLoginSuccessPage: true,
      },
    })
    respond(harness, 0, {
      type: 'chatgpt',
      loginId: 'login-1',
      authUrl: 'https://chatgpt.com/oauth/authorize?redirect_uri=http://localhost/callback',
    })

    await expect(login).resolves.toMatchObject({
      type: 'chatgpt',
      loginId: 'login-1',
    })
    client.close()
    harness.peer.close()
  })

  it('rejects an authorization URL on an attacker-controlled origin', async () => {
    const harness = createHarness()
    const client = new CodexAccountClient(harness.peer)
    const login = client.startBrowserLogin()
    await waitForOutbound(harness, 1)
    respond(harness, 0, {
      type: 'chatgpt',
      loginId: 'login-evil',
      authUrl: 'https://chatgpt.com.evil.example/steal',
    })

    await expect(login).rejects.toBeInstanceOf(CodexLoginError)
    client.close()
    harness.peer.close()
  })

  it('supports the headless device-code flow', async () => {
    const harness = createHarness()
    const client = new CodexAccountClient(harness.peer)
    const login = client.startDeviceCodeLogin()
    await waitForOutbound(harness, 1)
    expect(harness.outbound[0]).toMatchObject({
      method: 'account/login/start',
      params: { type: 'chatgptDeviceCode' },
    })
    respond(harness, 0, {
      type: 'chatgptDeviceCode',
      loginId: 'device-1',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    })

    await expect(login).resolves.toEqual({
      type: 'chatgptDeviceCode',
      loginId: 'device-1',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    })
    client.close()
    harness.peer.close()
  })

  it('correlates login completion and verifies the refreshed account', async () => {
    const harness = createHarness()
    const client = new CodexAccountClient(harness.peer)
    const completed = client.waitForLogin('login-2')
    harness.inbound.write(
      `${JSON.stringify({
        method: 'account/login/completed',
        params: { loginId: 'login-2', success: true, error: null },
      })}\n`,
    )
    await waitForOutbound(harness, 1)
    respond(harness, 0, {
      account: { type: 'chatgpt', email: null, planType: 'pro' },
      requiresOpenaiAuth: true,
    })

    await expect(completed).resolves.toMatchObject({
      connected: true,
      authType: 'chatgpt',
      planType: 'pro',
      emailHint: null,
    })
    client.close()
    harness.peer.close()
  })

  it('fails a rejected login without exposing the upstream error payload', async () => {
    const harness = createHarness()
    const client = new CodexAccountClient(harness.peer)
    const completed = client.waitForLogin('login-3')
    harness.inbound.write(
      `${JSON.stringify({
        method: 'account/login/completed',
        params: {
          loginId: 'login-3',
          success: false,
          error: 'sensitive upstream account detail',
        },
      })}\n`,
    )

    await expect(completed).rejects.toThrow('ChatGPT login failed or was cancelled')
    await expect(completed).rejects.not.toThrow('sensitive upstream account detail')
    client.close()
    harness.peer.close()
  })

  it('sends correlated cancel and logout requests', async () => {
    const harness = createHarness()
    const client = new CodexAccountClient(harness.peer)
    const cancel = client.cancelLogin('login-4')
    await waitForOutbound(harness, 1)
    expect(harness.outbound[0]).toMatchObject({
      method: 'account/login/cancel',
      params: { loginId: 'login-4' },
    })
    respond(harness, 0, {})
    await cancel

    const logout = client.logout()
    await waitForOutbound(harness, 2)
    expect(harness.outbound[1]).toMatchObject({ method: 'account/logout' })
    respond(harness, 1, {})
    await logout
    client.close()
    harness.peer.close()
  })

  it('bounds waits and rejects them when the transport closes', async () => {
    const harness = createHarness()
    const client = new CodexAccountClient(harness.peer)
    await expect(client.waitForLogin('timeout', { timeoutMs: 5 })).rejects.toThrow(
      'ChatGPT login timed out',
    )

    const pending = client.waitForLogin('closed')
    harness.peer.close(new CodexRpcClosedError('test close'))
    await expect(pending).rejects.toThrow('test close')
  })
})
