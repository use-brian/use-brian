import { describe, expect, it, vi } from 'vitest'
import { probeMailboxFolders } from '../probe.js'
import type { ImapClientLike } from '../imap-session.js'

const SETTINGS = {
  email: 'maya@harborlane.example',
  appPassword: 'pw',
  imapHost: 'imap.example',
  imapPort: 993,
  smtpHost: 'smtp.example',
  smtpPort: 465,
}

describe('[COMP:api/mailbox-connect-routes] mailbox preflight completeness', () => {
  it('marks a partial STATUS walk incomplete instead of laundering the sum into a total', async () => {
    const client = {
      connect: vi.fn(async () => {}),
      logout: vi.fn(async () => {}),
      close: vi.fn(),
      list: vi.fn(async () => [
        { path: 'INBOX' },
        { path: 'Archive' },
        { path: '[Gmail]', flags: new Set(['\\Noselect']) },
      ]),
      status: vi.fn(async (path: string) => {
        if (path === 'Archive') throw new Error('connection reset')
        return { path, messages: 97, uidNext: 98, uidValidity: 1n }
      }),
    } as unknown as ImapClientLike

    await expect(probeMailboxFolders(SETTINGS, () => client)).resolves.toEqual({
      folders: [{ path: 'INBOX', messages: 97 }],
      failedFolders: [{ path: 'Archive' }],
      complete: false,
      total: 97,
    })
  })

  it('marks the estimate complete only when every syncable folder was counted', async () => {
    const client = {
      connect: vi.fn(async () => {}),
      logout: vi.fn(async () => {}),
      close: vi.fn(),
      list: vi.fn(async () => [{ path: 'INBOX' }, { path: 'Sent' }]),
      status: vi.fn(async (path: string) => ({
        path,
        messages: path === 'INBOX' ? 4 : 2,
        uidNext: 1,
        uidValidity: 1n,
      })),
    } as unknown as ImapClientLike

    await expect(probeMailboxFolders(SETTINGS, () => client)).resolves.toMatchObject({
      complete: true,
      failedFolders: [],
      total: 6,
    })
  })

  it('directly counts a previously seen folder omitted from the latest LIST response', async () => {
    const client = {
      connect: vi.fn(async () => {}),
      logout: vi.fn(async () => {}),
      close: vi.fn(),
      list: vi.fn(async () => [{ path: 'INBOX' }]),
      status: vi.fn(async (path: string) => ({
        path,
        messages: path === 'INBOX' ? 97 : 5_400,
        uidNext: 1,
        uidValidity: 1n,
      })),
    } as unknown as ImapClientLike

    await expect(probeMailboxFolders(SETTINGS, () => client, ['INBOX', 'Archive'])).resolves.toEqual({
      folders: [
        { path: 'INBOX', messages: 97 },
        { path: 'Archive', messages: 5_400 },
      ],
      failedFolders: [],
      complete: true,
      total: 5_497,
    })
    expect(client.status).toHaveBeenCalledWith('Archive', expect.any(Object))
  })

  it('keeps the estimate incomplete when an omitted known folder is no longer addressable', async () => {
    const client = {
      connect: vi.fn(async () => {}),
      logout: vi.fn(async () => {}),
      close: vi.fn(),
      list: vi.fn(async () => [{ path: 'INBOX' }]),
      status: vi.fn(async (path: string) => {
        if (path === 'Archive') throw new Error('folder temporarily unavailable')
        return { path, messages: 97, uidNext: 98, uidValidity: 1n }
      }),
    } as unknown as ImapClientLike

    await expect(probeMailboxFolders(SETTINGS, () => client, ['Archive'])).resolves.toMatchObject({
      folders: [{ path: 'INBOX', messages: 97 }],
      failedFolders: [{ path: 'Archive' }],
      complete: false,
      total: 97,
    })
  })
})
