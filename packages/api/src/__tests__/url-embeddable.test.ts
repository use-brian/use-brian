import { describe, expect, it } from 'vitest'
import { decideFrameEmbedding, frameAncestors } from '../url-embeddable.js'

describe('[COMP:api/url-embeddable] can the Chat side pane frame this page (chat-parity T9)', () => {
  it('allows a page that sends neither header', () => {
    expect(decideFrameEmbedding({})).toEqual({ embeddable: true, reason: 'allowed' })
    expect(decideFrameEmbedding({ contentSecurityPolicy: "default-src 'self'" }).embeddable).toBe(true)
  })

  it('refuses any X-Frame-Options value', () => {
    for (const value of ['DENY', 'SAMEORIGIN', 'ALLOW-FROM https://app.usebrian.ai']) {
      expect(decideFrameEmbedding({ xFrameOptions: value })).toEqual({
        embeddable: false, reason: 'x_frame_options',
      })
    }
  })

  it('refuses frame-ancestors unless it allows any origin', () => {
    expect(decideFrameEmbedding({ contentSecurityPolicy: "frame-ancestors 'none'" }).reason).toBe('frame_ancestors')
    expect(decideFrameEmbedding({ contentSecurityPolicy: "frame-ancestors 'self' https://partner.example" }).embeddable).toBe(false)
    expect(decideFrameEmbedding({ contentSecurityPolicy: 'frame-ancestors *' }).embeddable).toBe(true)
    expect(decideFrameEmbedding({ contentSecurityPolicy: "script-src 'self'; frame-ancestors https:" }).embeddable).toBe(true)
  })

  it('applies the strictest of several joined policies', () => {
    expect(frameAncestors("frame-ancestors *, frame-ancestors 'self'")).toEqual(["'self'"])
    expect(decideFrameEmbedding({ contentSecurityPolicy: "frame-ancestors *, frame-ancestors 'self'" }).embeddable).toBe(false)
    expect(frameAncestors(null)).toBeNull()
  })
})
