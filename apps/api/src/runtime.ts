export function resolveApiJwtSecret(
  edition: string | undefined,
  configuredSecret: string | undefined,
  ephemeralSecret: string,
): string {
  if (edition?.trim().toLowerCase() === 'outpost' && !configuredSecret) {
    throw new Error('JWT_SECRET is required for an Outpost deployment')
  }
  return configuredSecret || ephemeralSecret
}

export function shouldRunApiWorkers(argv: readonly string[]): boolean {
  return !argv.includes('--no-workers')
}
