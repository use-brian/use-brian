/**
 * [COMP:shared/page-icon] Image page-icon token helpers.
 *
 * The `img:<workspaceId>/<fileId>` token is the wire format shared by the
 * core zod schemas (accept), the api `fetchSiteIcon` tool (mint), and the
 * app-web `PageIcon` renderer (parse) — this test pins the round-trip and
 * the reject cases so the three consumers can't drift.
 */

import { describe, expect, it } from 'vitest'
import {
  ICON_IMAGE_PREFIX,
  IMAGE_ICON_RE,
  imageIconToken,
  isImageIcon,
  parseImageIcon,
} from '../page-icon.js'

const WS = '11111111-2222-3333-4444-555555555555'
const FILE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

describe('[COMP:shared/page-icon] image icon token', () => {
  it('round-trips mint → detect → parse', () => {
    const token = imageIconToken(WS, FILE)
    expect(token).toBe(`${ICON_IMAGE_PREFIX}${WS}/${FILE}`)
    expect(isImageIcon(token)).toBe(true)
    expect(parseImageIcon(token)).toEqual({ workspaceId: WS, fileId: FILE })
  })

  it('rejects emoji, null, and junk shapes', () => {
    for (const v of [
      '🌱',
      null,
      undefined,
      '',
      'img:',
      `img:${WS}`, // missing file half
      `img:${WS}/${FILE}/extra`, // trailing junk
      `img:../../etc/passwd/${FILE}`, // path-shaped junk
      `IMG:${WS}/${FILE}x`, // bad uuid tail
    ]) {
      expect(isImageIcon(v)).toBe(false)
      expect(parseImageIcon(v)).toBeNull()
    }
  })

  it('regex is anchored (no partial matches inside longer strings)', () => {
    expect(IMAGE_ICON_RE.test(`x${imageIconToken(WS, FILE)}`)).toBe(false)
    expect(IMAGE_ICON_RE.test(`${imageIconToken(WS, FILE)}y`)).toBe(false)
  })
})
