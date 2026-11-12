// Pure local-launch policy; importing this module never boots services or reads files.
function port(value, name) {
  const text = String(value).trim()
  const result = Number(text)
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(result) || result < 1 || result > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535`)
  }
  return result
}

export function resolveDocSyncLaunch(env = {}, outpostLocal = false) {
  const docSyncPort = port(env.USEBRIAN_DOC_SYNC_PORT || (outpostLocal ? 8180 : 8080), 'USEBRIAN_DOC_SYNC_PORT')
  // Internal traffic stays on IPv4 loopback; browser URLs follow the launcher's
  // localhost convention, unless a deployment explicitly supplies its own URL.
  const browserUrl = env.PUBLIC_DOC_SYNC_URL ||
    (env.DOC_SYNC_DOMAIN ? `wss://${env.DOC_SYNC_DOMAIN}` : undefined) ||
    env.NEXT_PUBLIC_DOC_SYNC_URL || `ws://localhost:${docSyncPort}`
  return {
    port: docSyncPort,
    env: {
      DOC_SYNC_URL: `ws://127.0.0.1:${docSyncPort}`,
      PUBLIC_DOC_SYNC_URL: browserUrl,
      NEXT_PUBLIC_DOC_SYNC_URL: browserUrl,
    },
  }
}

export function resolveOutpostMailbox(env = {}, outpostLocal = false) {
  // Even a credentials-only override means the user owns SMTP configuration.
  // Do not mix partial external settings with fixture credentials or listeners.
  const external = Object.entries(env).some(([key, value]) =>
    key.startsWith('SMTP_') && value !== undefined && value !== '')
  if (!outpostLocal || external) {
    if (outpostLocal && env.SMTP_PORT) port(env.SMTP_PORT, 'SMTP_PORT')
    return { enabled: false, env: {} }
  }
  return {
    enabled: true,
    port: 2525,
    env: {
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '2525',
      SMTP_SECURE: 'false',
      // These must match rig-mailbox.mjs's CLI defaults.
      SMTP_USER: 'capture@fixture.example',
      SMTP_PASSWORD: 'fixture-only',
      EMAIL_FROM_ADDRESS: env.EMAIL_FROM_ADDRESS || 'auth@fixture.example',
      OUTPOST_AUTH_BOOTSTRAP_EMAILS: env.OUTPOST_AUTH_BOOTSTRAP_EMAILS || 'admin@fixture.example',
    },
  }
}
