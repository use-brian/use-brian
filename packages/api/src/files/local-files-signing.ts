import { createHmac, timingSafeEqual } from 'node:crypto'

export type LocalFileAction = 'read' | 'write'

export type LocalFileGrant = {
  action: LocalFileAction
  key: string
  expires: number
  mime?: string
}

function grantPayload(grant: LocalFileGrant): string {
  return JSON.stringify([grant.action, grant.key, grant.expires, grant.mime ?? ''])
}

export function signLocalFileGrant(grant: LocalFileGrant, secret: string): string {
  return createHmac('sha256', secret).update(grantPayload(grant)).digest('base64url')
}

export function verifyLocalFileGrant(grant: LocalFileGrant, signature: string, secret: string): boolean {
  if (!Number.isSafeInteger(grant.expires) || grant.expires < Math.floor(Date.now() / 1000)) return false
  const expected = Buffer.from(signLocalFileGrant(grant, secret), 'utf8')
  const actual = Buffer.from(signature, 'utf8')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function buildLocalFileTransferUrl(args: {
  apiUrl: string
  secret: string
  grant: LocalFileGrant
}): string {
  const url = new URL('/api/local-files', args.apiUrl)
  url.searchParams.set('action', args.grant.action)
  url.searchParams.set('key', args.grant.key)
  url.searchParams.set('expires', String(args.grant.expires))
  if (args.grant.mime) url.searchParams.set('mime', args.grant.mime)
  url.searchParams.set('signature', signLocalFileGrant(args.grant, args.secret))
  return url.toString()
}
