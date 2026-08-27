export function assertOutpostRuntime(env: NodeJS.ProcessEnv): string {
  if (env.USEBRIAN_EDITION?.trim().toLowerCase() !== 'outpost') {
    throw new Error('The Outpost API requires USEBRIAN_EDITION=outpost')
  }
  if (!env.JWT_SECRET) {
    throw new Error('JWT_SECRET is required for an Outpost deployment')
  }
  return env.JWT_SECRET
}
