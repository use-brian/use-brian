// Spec: docs/workflow/browser-extension-release.md
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const repository = 'use-brian/use-brian'
const defaultExtensionId = 'nnmbbacnkekaoccmkmlfaghjaamgdpjn'
const requireThat = (condition, message) => { if (!condition) throw new Error(message) }
const command = (file, args, options = {}) => execFileSync(file, args, {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options,
})?.trim()

function versionParts(version) {
  requireThat(typeof version === 'string' && /^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(version),
    `Invalid Chrome version: ${version}`)
  const parts = version.split('.').map(Number)
  requireThat(parts.every(part => part <= 65535) && parts.some(part => part !== 0),
    `Invalid Chrome version: ${version}`)
  return parts.concat([0, 0, 0, 0]).slice(0, 4)
}

export function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right)
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

function revisionVersions(revision) {
  requireThat(Array.isArray(revision.distributionChannels) && revision.distributionChannels.length > 0,
    'Store revision has no distribution channels')
  return revision.distributionChannels.map(channel => {
    versionParts(channel.crxVersion)
    return channel.crxVersion
  })
}

export function planRelease(version, status, extensionId = defaultExtensionId) {
  versionParts(version)
  requireThat(status?.itemId === extensionId, 'Store status does not match the expected extension')
  requireThat(!status.takenDown, 'Store item is taken down; resolve it in the Developer Dashboard')
  requireThat(!status.warned, 'Store item has a policy warning; resolve it in the Developer Dashboard')
  const published = status.publishedItemRevisionStatus
  requireThat(published && ['PUBLISHED', 'PUBLISHED_TO_TESTERS'].includes(published.state),
    'Publish the initial Store listing in the Developer Dashboard before enabling automatic updates')
  const publishedVersions = revisionVersions(published)
  if (publishedVersions.some(current => compareVersions(version, current) <= 0)) {
    return { release: false, reason: `Version ${version} is already published or superseded` }
  }
  const submitted = status.submittedItemRevisionStatus
  if (submitted) {
    requireThat(['PENDING_REVIEW', 'STAGED', 'PUBLISHED', 'PUBLISHED_TO_TESTERS', 'REJECTED', 'CANCELLED'].includes(submitted.state),
      'Store returned an unknown submission state')
    const submittedVersions = revisionVersions(submitted)
    if (['PENDING_REVIEW', 'STAGED'].includes(submitted.state)) {
      return { release: false, reason: `Store revision is ${submitted.state}; retry after it finishes` }
    }
    if (['PUBLISHED', 'PUBLISHED_TO_TESTERS'].includes(submitted.state) &&
      submittedVersions.some(current => compareVersions(version, current) <= 0)) {
      return { release: false, reason: `Version ${version} is already published or superseded` }
    }
    requireThat(!submittedVersions.some(current => compareVersions(version, current) <= 0),
      `Store submission is ${submitted.state}; inspect the dashboard and commit a higher corrected version`)
  }
  if (status.lastAsyncUploadState === 'IN_PROGRESS') {
    return { release: false, reason: 'A Store upload is still being validated; retry after it finishes' }
  }
  return { release: true, reason: `New extension version ${version}` }
}

// Check independently of the workflow event condition, including manual retries.
export function verifyProduction(sha, execute = command) {
  requireThat(typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha), 'Expected a full source commit SHA')
  requireThat(execute('git', ['rev-parse', 'HEAD']) === sha, 'Checkout does not match the tested source SHA')
  const api = path => JSON.parse(execute('gh', ['api', `repos/${repository}/${path}`]))
  if (api('git/ref/heads/main').object.sha !== sha) return false
  const runs = api(`actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=${sha}&per_page=100`).workflow_runs
  const latest = runs.filter(run => run.head_sha === sha && run.head_branch === 'main' && run.event === 'push' &&
    run.head_repository?.full_name === repository)
    .sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)[0]
  requireThat(latest?.status === 'completed' && latest.conclusion === 'success',
    'The latest main push CI run for this SHA must have succeeded')
  return true
}

async function requestJson(request, url, options, label) {
  const response = await request(url, { ...options, signal: AbortSignal.timeout(30_000) })
  // Do not print OAuth responses or request options: they can contain credentials.
  requireThat(response.ok, `${label} failed (HTTP ${response.status})`)
  return response.json()
}

export async function publishRelease(sha, { execute = command, request = fetch, env = process.env } = {}) {
  if (!verifyProduction(sha, execute)) return { release: false, reason: 'Main moved; wait for its CI run' }
  for (const name of ['CHROME_WEB_STORE_PUBLISHER_ID', 'CHROME_WEB_STORE_CLIENT_ID',
    'CHROME_WEB_STORE_CLIENT_SECRET', 'CHROME_WEB_STORE_REFRESH_TOKEN']) {
    requireThat(env[name], `Missing browser-extension-release environment secret: ${name}`)
  }
  const publisher = env.CHROME_WEB_STORE_PUBLISHER_ID
  const extensionId = env.CHROME_WEB_STORE_EXTENSION_ID || defaultExtensionId
  requireThat(/^[A-Za-z0-9_-]+$/.test(publisher), 'Invalid Chrome Web Store publisher ID')
  requireThat(/^[a-p]{32}$/.test(extensionId), 'Invalid Chrome extension ID')
  const version = JSON.parse(readFileSync(resolve(root, 'apps/browser-extension/static/manifest.json'), 'utf8')).version
  versionParts(version)
  const token = await requestJson(request, 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: env.CHROME_WEB_STORE_CLIENT_ID,
      client_secret: env.CHROME_WEB_STORE_CLIENT_SECRET,
      refresh_token: env.CHROME_WEB_STORE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  }, 'OAuth refresh')
  requireThat(typeof token.access_token === 'string' && token.access_token.length > 0, 'OAuth refresh returned no access token')
  if (env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${token.access_token}`)
  const status = await requestJson(request,
    `https://chromewebstore.googleapis.com/v2/publishers/${publisher}/items/${extensionId}:fetchStatus`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    }, 'Chrome Web Store status check')
  const plan = planRelease(version, status, extensionId)
  if (plan.release) {
    // The existing script rechecks the Store after building; it also rechecks
    // production immediately before upload when this source SHA is supplied.
    execute('bash', [resolve(root, 'scripts/publish-browser-extension.sh'), '--publish', '--auto-publish', '--yes'], {
      stdio: 'inherit',
      env: { ...env, CHROME_WEB_STORE_ACCESS_TOKEN: token.access_token, CHROME_WEB_STORE_SOURCE_SHA: sha },
    })
  }
  return plan
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const [mode, sha, ...extra] = process.argv.slice(2)
    requireThat(extra.length === 0, 'Unexpected release arguments')
    let result
    if (mode === 'verify' || mode === 'verify-upload') {
      const ready = verifyProduction(sha)
      if (mode === 'verify-upload') requireThat(ready, 'Main moved during the build; refusing to upload obsolete source')
      result = { ready, sha }
      if (mode === 'verify' && process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, `ready=${ready}\nsha=${sha}\n`)
      }
    } else {
      requireThat(mode === 'publish', 'Usage: release.mjs verify|verify-upload|publish SOURCE_SHA')
      result = await publishRelease(sha)
    }
    console.log(JSON.stringify(result))
    if (process.env.GITHUB_STEP_SUMMARY && result.reason) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Chrome extension: ${result.reason}.\n`)
    }
  } catch (error) {
    // Child-process errors can include captured output; report only the message.
    console.error(`error: ${error.message}`)
    process.exitCode = 1
  }
}
