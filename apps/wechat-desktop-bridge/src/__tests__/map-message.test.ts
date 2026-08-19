/**
 * [COMP:app/wechat-desktop-bridge] map-message: agent-wechat row → BridgeInbound.message.
 */
import { describe, expect, it } from 'vitest'
import {
  ATTACHMENT_UNAVAILABLE,
  extractAppMessageTitle,
  mapMessage,
  messageMayHaveMedia,
  mimeForMedia,
} from '../map-message.js'
import { chat, msg } from './fakes.js'

const dm = chat({ id: 'wxid_example1', name: 'Test Contact', remark: 'Tester' })
const group = chat({ id: '12345678@chatroom', name: 'Test Group', isGroup: true })

describe('[COMP:app/wechat-desktop-bridge] mapMessage', () => {
  it('maps a text DM with peer, sender and timestamp', () => {
    const out = mapMessage(msg({ localId: 5, chatId: dm.id, sender: 'wxid_example1', content: 'hi there' }), dm)
    expect(out).toMatchObject({
      peerId: 'wxid_example1',
      peerName: 'Tester',
      senderId: 'wxid_example1',
      senderName: 'Tester',
      text: 'hi there',
      isGroupChat: false,
      isSelf: false,
      isMentioned: false,
      timestamp: Date.parse('2026-08-19T10:00:00.000Z'),
    })
    expect(out!.messageId).toBe('1000005')
  })

  it('skips system rows (10000, 10002)', () => {
    expect(mapMessage(msg({ localId: 1, chatId: dm.id, type: 10000, content: 'x joined' }), dm)).toBeNull()
    expect(mapMessage(msg({ localId: 2, chatId: dm.id, type: 10002, content: 'recalled' }), dm)).toBeNull()
  })

  it('renders a sticker as [sticker]', () => {
    expect(mapMessage(msg({ localId: 3, chatId: dm.id, type: 47, content: '<msg/>' }), dm)!.text).toBe('[sticker]')
  })

  it('marks isSelf and falls back to the chat id as sender', () => {
    const out = mapMessage(msg({ localId: 4, chatId: dm.id, isSelf: true, content: 'from my phone' }), dm)
    expect(out!.isSelf).toBe(true)
    expect(out!.senderId).toBe('wxid_example1')
  })

  it('detects groups by flag or @chatroom suffix and carries isMentioned', () => {
    const out = mapMessage(
      msg({ localId: 6, chatId: group.id, sender: 'wxid_member2', senderName: 'Member Two', isMentioned: true, content: '@me hey' }),
      group,
    )
    expect(out).toMatchObject({ peerId: group.id, isGroupChat: true, senderId: 'wxid_member2', senderName: 'Member Two', isMentioned: true })
    const suffixOnly = chat({ id: '999@chatroom', isGroup: false })
    expect(mapMessage(msg({ localId: 7, chatId: suffixOnly.id, content: 'x' }), suffixOnly)!.isGroupChat).toBe(true)
  })

  it('uses replyToMessageId when the reply carries an id, else appends a quoted block', () => {
    const withId = mapMessage(
      msg({ localId: 8, chatId: dm.id, content: 'yes', reply: { sender: 'Me', content: 'ok?', messageId: 'srv-77' } }),
      dm,
    )
    expect(withId!.replyToMessageId).toBe('srv-77')
    expect(withId!.text).toBe('yes')
    const quoted = mapMessage(msg({ localId: 9, chatId: dm.id, content: 'yes', reply: { sender: 'Me', content: 'ok?' } }), dm)
    expect(quoted!.replyToMessageId).toBeUndefined()
    expect(quoted!.text).toBe('yes\n\n[Replying to Me]\nok?\n[/Replying]')
  })

  it('attaches fetched media inline with mime from the format map', () => {
    const out = mapMessage(
      msg({ localId: 10, chatId: dm.id, type: 3, content: '' }),
      dm,
      { status: 'fetched', result: { type: 'image', data: 'aGVsbG8=', format: 'jpg', filename: 'photo.jpg' } },
    )
    expect(out!.media).toEqual([{ kind: 'image', mime: 'image/jpeg', name: 'photo.jpg', dataBase64: 'aGVsbG8=', sizeBytes: 5 }])
    expect(out!.text).toBe('')
    const voice = mapMessage(
      msg({ localId: 11, chatId: dm.id, type: 34, content: '' }),
      dm,
      { status: 'fetched', result: { type: 'voice', data: 'aGVsbG8=', format: 'mp3', filename: '' } },
    )
    expect(voice!.media![0]).toMatchObject({ kind: 'voice', mime: 'audio/mpeg', name: '11.mp3' })
    const video = mapMessage(
      msg({ localId: 12, chatId: dm.id, type: 43, content: '' }),
      dm,
      { status: 'fetched', result: { type: 'video', data: 'aGVsbG8=', format: 'mp4', filename: 'v.mp4' } },
    )
    expect(video!.media![0].kind).toBe('video')
  })

  it('maps a type-49 file to a document whose text is the filename', () => {
    const out = mapMessage(
      msg({ localId: 13, chatId: dm.id, type: 49, content: '<msg><appmsg><title>report.pdf</title></appmsg></msg>' }),
      dm,
      { status: 'fetched', result: { type: 'file', data: 'aGVsbG8=', format: 'pdf', filename: 'report.pdf' } },
    )
    expect(out!.media![0]).toMatchObject({ kind: 'document', mime: 'application/pdf', name: 'report.pdf' })
    expect(out!.text).toBe('report.pdf')
  })

  it('renders a type-49 link as [link] <title> when no media, raw content when no title', () => {
    const link = mapMessage(
      msg({ localId: 14, chatId: dm.id, type: 49, content: '&lt;msg&gt;&lt;appmsg&gt;&lt;title&gt;Some article&lt;/title&gt;&lt;/appmsg&gt;&lt;/msg&gt;' }),
      dm,
      { status: 'unsupported' },
    )
    expect(link!.text).toBe('[link] Some article')
    const raw = mapMessage(msg({ localId: 15, chatId: dm.id, type: 49, content: 'plain app content' }), dm, { status: 'unsupported' })
    expect(raw!.text).toBe('plain app content')
  })

  it('falls back to [attachment unavailable] when media never arrives', () => {
    const out = mapMessage(msg({ localId: 16, chatId: dm.id, type: 3, content: '<img/>' }), dm, { status: 'unavailable' })
    expect(out!.text).toBe(ATTACHMENT_UNAVAILABLE)
    expect(out!.media).toBeUndefined()
    const app49 = mapMessage(
      msg({ localId: 17, chatId: dm.id, type: 49, content: '<msg><appmsg><title>big.zip</title></appmsg></msg>' }),
      dm,
      { status: 'unavailable' },
    )
    expect(app49!.text).toBe(`[link] big.zip ${ATTACHMENT_UNAVAILABLE}`)
  })

  it('helpers: messageMayHaveMedia, mimeForMedia, extractAppMessageTitle', () => {
    expect(messageMayHaveMedia({ type: 3 })).toBe(true)
    expect(messageMayHaveMedia({ type: 49 })).toBe(true)
    expect(messageMayHaveMedia({ type: 1 })).toBe(false)
    expect(messageMayHaveMedia({ type: 47 })).toBe(false)
    expect(mimeForMedia({ type: 'file', format: 'docx' })).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    expect(mimeForMedia({ type: 'image', format: 'heic' })).toBe('image/heic')
    expect(mimeForMedia({ type: 'file', format: 'weird' })).toBe('application/octet-stream')
    expect(extractAppMessageTitle('<title><![CDATA[Hello]]></title>')).toBe('Hello')
    expect(extractAppMessageTitle('nothing')).toBeNull()
  })
})
