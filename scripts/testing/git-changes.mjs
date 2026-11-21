// [COMP:ci/execution-topology] Compare the complete event range for both CI and images.
export function compareChangedPaths(eventName, event, git) {
  const isRevision = value => /^[a-f0-9]{40}$/.test(value ?? '') && !/^0+$/.test(value)
  let base, head
  if (eventName === 'pull_request') {
    head = event.pull_request.head.sha
    const target = event.pull_request.base.sha
    if (![target, head].every(isRevision)) throw new Error('Missing pull request revision')
    base = git(['merge-base', target, head]).trim()
  } else if (eventName === 'push') {
    base = event.before; head = event.after
  }
  if (![base, head].every(isRevision)) throw new Error('Missing revision')
  // --no-renames includes both sides of a rename; -z preserves unusual paths.
  const paths = git(['diff', '--name-only', '--no-renames', '-z', base, head]).split('\0').filter(Boolean)
  return { base, head, paths }
}
