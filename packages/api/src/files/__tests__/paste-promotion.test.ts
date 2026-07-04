import { describe, it, expect, vi } from 'vitest'
import {
  promotePastedText,
  shouldPromotePaste,
  PASTE_PROMOTION_THRESHOLD_TOKENS,
  PASTE_HEAD_EXCERPT_CHARS,
} from '../paste-promotion.js'

const BIG_ASCII = 'The quarterly numbers are strong. '.repeat(1200) // ~40K chars ≈ 10K tokens
const BIG_CJK = '這是一段很長的中文內容。'.repeat(800) // ~9.6K chars ≈ ~9.6K tokens

describe('[COMP:files/paste-promotion] shouldPromotePaste threshold', () => {
  it('is CJK-aware: ~9.6K CJK chars trip the 8K-token gate; the same char count of ASCII does not', () => {
    expect(shouldPromotePaste(BIG_CJK)).toBe(true)
    expect(shouldPromotePaste('a'.repeat(BIG_CJK.length))).toBe(false)
  })

  it('short pastes never promote', () => {
    expect(shouldPromotePaste('hello world')).toBe(false)
  })

  it('the threshold sits above the 5K attach-inline gate', () => {
    expect(PASTE_PROMOTION_THRESHOLD_TOKENS).toBeGreaterThan(5000)
  })
})

describe('[COMP:files/paste-promotion] promotePastedText', () => {
  const base = {
    workspaceId: 'ws-1',
    actingUserId: 'u-1',
    assistantId: 'a-1',
  }

  it('below threshold returns null without calling the promoter', async () => {
    const promote = vi.fn()
    const res = await promotePastedText({ ...base, text: 'short', promote })
    expect(res).toBeNull()
    expect(promote).not.toHaveBeenCalled()
  })

  it('promotes an over-threshold paste and returns note + head excerpt + manifest', async () => {
    const promote = vi.fn().mockResolvedValue({
      fileId: 'wf-1',
      path: '/uploads/pastes/paste-x.txt',
      status: 'ready',
      segmentCount: 33,
      truncated: false,
    })
    const res = await promotePastedText({ ...base, text: BIG_ASCII, promote })
    expect(res).not.toBeNull()
    expect(promote).toHaveBeenCalledWith(
      expect.objectContaining({
        mime: 'text/plain',
        workspaceId: 'ws-1',
        actingUserId: 'u-1',
        pathPrefix: '/uploads/pastes',
        parsedText: BIG_ASCII,
      }),
    )
    expect(res!.fileId).toBe('wf-1')
    expect(res!.replaced).toContain('was saved to the workspace file "/uploads/pastes/paste-x.txt"')
    expect(res!.replaced).toContain(BIG_ASCII.slice(0, PASTE_HEAD_EXCERPT_CHARS))
    expect(res!.replaced).toContain('searchFileContent with fileId="wf-1"')
    expect(res!.replaced).toContain('33 indexed sections')
    // The replacement is a tiny fraction of the original.
    expect(res!.replaced.length).toBeLessThan(BIG_ASCII.length / 10)
    expect(res!.replaced).not.toContain('—')
  })

  it('promotion failure returns null (the caller keeps the original paste)', async () => {
    const promote = vi.fn().mockResolvedValue(null)
    const res = await promotePastedText({ ...base, text: BIG_ASCII, promote })
    expect(res).toBeNull()
  })
})
