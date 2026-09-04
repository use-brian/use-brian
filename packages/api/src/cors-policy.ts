/** CORS admission for the installed file:// renderer's opaque origin. */

function headerIncludesAuthorization(value: string | readonly string[] | undefined): boolean {
  const joined = typeof value === 'string' ? value : value?.join(',')
  return joined
    ?.split(',')
    .some((header) => header.trim().toLowerCase() === 'authorization') ?? false
}

export function isOpaqueDesktopBearerRequest(input: {
  path: string
  authorization?: string | readonly string[]
  requestedHeaders?: string | readonly string[]
}): boolean {
  const authorization = typeof input.authorization === 'string'
    ? input.authorization
    : input.authorization?.[0]
  if (authorization?.startsWith('Bearer ') && authorization.length > 'Bearer '.length) {
    return true
  }
  if (headerIncludesAuthorization(input.requestedHeaders)) return true

  // Desktop refresh carries its explicit refresh-token secret in the JSON body,
  // so its preflight has Content-Type but no Authorization header.
  return input.path === '/auth/refresh'
}
