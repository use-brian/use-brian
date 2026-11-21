import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compareChangedPaths } from './git-changes.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))

// [COMP:ci/execution-topology] Validation, digest builds and publishing use one matrix.
export const imageMatrix = [
  'api', 'app-web', 'auth-web', 'browser-relay', 'discord-connector', 'doc-sync',
  'feishu-connector', 'wa-connector', 'wechat-connector', 'wechat-desktop-bridge',
].map(image => ({ image, context: image === 'wechat-desktop-bridge' ? `apps/${image}` : '.', dockerfile: `apps/${image}/Dockerfile` }))

export function workspacePackages(directory) {
  const packages = new Map()
  for (const workspace of ['apps', 'packages']) {
    for (const entry of readdirSync(join(directory, workspace), { withFileTypes: true })) {
      const path = `${workspace}/${entry.name}`
      const manifest = join(directory, path, 'package.json')
      if (!entry.isDirectory() || !existsSync(manifest)) continue
      const metadata = JSON.parse(readFileSync(manifest, 'utf8'))
      if (!metadata.name || packages.has(metadata.name)) throw new Error('Invalid workspace package')
      packages.set(metadata.name, { path, metadata })
    }
  }
  return packages
}

export function workspaceClosure(packages, name, seen = new Set()) {
  if (seen.has(name)) return seen
  seen.add(name)
  const { metadata } = packages.get(name)
  const dependencies = [metadata.dependencies, metadata.devDependencies, metadata.optionalDependencies, metadata.peerDependencies]
  for (const [dependency, version] of dependencies.flatMap(field => Object.entries(field ?? {}))) {
    if (version.startsWith('workspace:')) workspaceClosure(packages, dependency, seen)
  }
  return seen
}

export function copiedSources(dockerfile) {
  const instructions = dockerfile.replace(/\\\r?\n/g, ' ')
  if (/^\s*#\s*escape\s*=|^\s*RUN\s+(?:[^\n]*\s)?--mount/im.test(instructions)) throw new Error('Unknown Docker context input')
  const sources = new Set()
  for (const line of instructions.split(/\r?\n/)) {
    const match = /^\s*(?:COPY|ADD)\s+(.+)$/i.exec(line)
    if (!match || match[1].startsWith('--from=')) continue
    const paths = match[1].trim().split(/\s+/).slice(0, -1)
    if (!paths.length || paths.some(path => path.startsWith('-') || !/^[\w./-]+$/.test(path) || path.split('/').includes('..'))) {
      throw new Error('Unknown Docker copy input')
    }
    for (const path of paths) sources.add(path)
  }
  return sources
}

const under = (path, prefix) => prefix === '.' || path === prefix || path.startsWith(`${prefix}/`)

export function selectDockerScope(eventName, event, git, directory = root) {
  const full = reason => ({ mode: 'full', reason, matrix: { include: imageMatrix } })
  if (eventName === 'workflow_dispatch' || event?.ref?.startsWith('refs/tags/')) return full('release-or-manual')
  try {
    const { paths } = compareChangedPaths(eventName, event, git)
    const packages = workspacePackages(directory)
    const owners = new Map([...packages].map(([name, item]) => [item.path, name]))
    const sharedInput = path => /(^|\/)(?:package\.json|pnpm-(?:workspace|lock)\.yaml|tsconfig(?:\.[\w-]+)?\.json|turbo\.json|[^/]*\.dockerignore)$/.test(path)
      || under(path, 'patches')
    if (!paths.length || paths.some(path => sharedInput(path) || !owners.has(path.split('/').slice(0, 2).join('/')))) {
      return full('shared-or-unknown-input')
    }
    const include = imageMatrix.filter(({ image, dockerfile, context }) => {
      const own = `apps/${image}`
      const closure = [...workspaceClosure(packages, owners.get(own))].map(name => packages.get(name).path)
      const copies = [...copiedSources(readFileSync(join(directory, dockerfile), 'utf8'))]
        .map(input => join(context, input).replace(/\/$/, ''))
      const inputs = [...closure, ...copies]
      return paths.some(path => inputs.some(input => under(path, input)))
    })
    return include.length ? { mode: 'affected', reason: 'docker-context-or-package', matrix: { include } } : full('no-known-image')
  } catch { return full('comparison-or-inputs-unavailable') }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  let event
  try { event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) } catch { /* Select the full matrix. */ }
  const scope = selectDockerScope(process.env.GITHUB_EVENT_NAME, event,
    args => execFileSync('git', args, { encoding: 'utf8' }))
  console.log(JSON.stringify({ mode: scope.mode, reason: scope.reason, images: scope.matrix.include.map(item => item.image) }))
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(scope.matrix)}\n`)
}
