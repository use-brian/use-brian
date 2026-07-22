/**
 * [COMP:app/wechat-connector] — QR pairing state machine.
 *
 * Drives the pairing session through iLink's login states with the channels
 * protocol functions mocked: scan → confirm hands the credentials to the
 * snapshot exactly once, `need_verifycode` parks the poll loop until the
 * digits arrive (and forwards them on the next poll), and an expired QR
 * refreshes in place.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@use-brian/channels', () => ({
  ILINK_DEFAULT_BASE_URL: 'https://ilink.example',
  fetchBotQrcode: vi.fn(),
  pollQrcodeStatus: vi.fn(),
}))

const { fetchBotQrcode, pollQrcodeStatus } = await import('@use-brian/channels')
const { createPairingManager } = await import('../pairing-manager.js')

const fetchQrMock = vi.mocked(fetchBotQrcode)
const pollMock = vi.mocked(pollQrcodeStatus)

beforeEach(() => {
  vi.clearAllMocks()
  fetchQrMock.mockResolvedValue({ qrcode: 'qr-1', qrcode_img_content: 'https://qr.example/1' })
})

describe('[COMP:app/wechat-connector] pairing state machine', () => {
  it('start() opens a session in the qr state', async () => {
    pollMock.mockResolvedValue({ status: 'wait' })
    const manager = createPairingManager()
    const started = await manager.start()
    expect(started.qrcodeUrl).toBe('https://qr.example/1')
    expect(manager.getStatus(started.pairingId)?.status).toBe('qr')
    manager.stopAll()
  })

  it('scan → confirmed stashes the credentials in the snapshot', async () => {
    pollMock
      .mockResolvedValueOnce({ status: 'scaned' })
      .mockResolvedValue({
        status: 'confirmed',
        bot_token: 'tok-1',
        ilink_bot_id: 'bot1@im.bot',
        baseurl: 'https://shdx.ilink.example',
        ilink_user_id: 'wxid_owner',
      })
    const manager = createPairingManager()
    const { pairingId } = await manager.start()

    await vi.waitFor(
      () => {
        expect(manager.getStatus(pairingId)?.status).toBe('confirmed')
      },
      { timeout: 5000 },
    )
    const snapshot = manager.getStatus(pairingId)!
    expect(snapshot.result).toEqual({
      botToken: 'tok-1',
      baseUrl: 'https://shdx.ilink.example',
      ilinkBotId: 'bot1@im.bot',
      boundUserId: 'wxid_owner',
    })
    expect(snapshot.qrcodeUrl).toBeUndefined()
    manager.stopAll()
  })

  it('need_verifycode parks the loop, then forwards the submitted digits', async () => {
    pollMock.mockResolvedValueOnce({ status: 'need_verifycode' })
    const manager = createPairingManager()
    const { pairingId } = await manager.start()

    await vi.waitFor(() => {
      expect(manager.getStatus(pairingId)?.status).toBe('need_verifycode')
    })
    // Parked: no further polls while the code is missing.
    const pollsWhileParked = pollMock.mock.calls.length
    await new Promise((r) => setTimeout(r, 50))
    expect(pollMock.mock.calls.length).toBe(pollsWhileParked)

    pollMock.mockResolvedValue({
      status: 'confirmed',
      bot_token: 'tok-2',
      ilink_bot_id: 'bot2@im.bot',
    })
    expect(manager.submitVerifyCode(pairingId, '482913')).toBe(true)

    await vi.waitFor(
      () => {
        expect(manager.getStatus(pairingId)?.status).toBe('confirmed')
      },
      { timeout: 5000 },
    )
    const carriedCode = pollMock.mock.calls.at(-1)?.[0]?.verifyCode
    expect(carriedCode).toBe('482913')
    manager.stopAll()
  })

  it('expired refreshes the QR in place', async () => {
    fetchQrMock
      .mockResolvedValueOnce({ qrcode: 'qr-1', qrcode_img_content: 'https://qr.example/1' })
      .mockResolvedValueOnce({ qrcode: 'qr-2', qrcode_img_content: 'https://qr.example/2' })
    pollMock.mockResolvedValueOnce({ status: 'expired' }).mockResolvedValue({ status: 'wait' })
    const manager = createPairingManager()
    const { pairingId } = await manager.start()

    await vi.waitFor(
      () => {
        expect(manager.getStatus(pairingId)?.qrcodeUrl).toBe('https://qr.example/2')
      },
      { timeout: 5000 },
    )
    expect(manager.getStatus(pairingId)?.status).toBe('qr')
    manager.stopAll()
  })

  it('submitVerifyCode on an unknown pairing returns false', () => {
    const manager = createPairingManager()
    expect(manager.submitVerifyCode('nope', '1')).toBe(false)
  })
})
