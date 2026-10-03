import type { RequestHandler } from 'express'
/** Mount after existing /internal shared-secret authentication, before native-enabled guard. */
export function nativeReadinessHandler(enabled: boolean): RequestHandler {
  return (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ enabled, protocol: 'native-computer-v1' })
  }
}
