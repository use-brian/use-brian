/** Server-side build edition. Hosted is the safe default when unset. */
export function isOssEdition(): boolean {
  return (
    process.env.USEBRIAN_EDITION === 'oss' ||
    process.env.NEXT_PUBLIC_USEBRIAN_EDITION === 'oss'
  )
}
