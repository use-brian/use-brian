#!/usr/bin/env node
// Spec: docs/architecture/features/app-desktop.md -> Automatic desktop releases.
// No signing credentials or release token are needed for planning/verification.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const repository = 'use-brian/use-brian';
const releaseDir = resolve(root, 'apps/app-desktop/release');
const macArtifactNames = ['usebrian.dmg', 'usebrian.zip', 'usebrian.zip.blockmap', 'latest-mac.yml'];
const windowsArtifactNames = ['usebrian.exe', 'usebrian.exe.blockmap', 'latest.yml'];
const provenanceName = 'desktop-release.json';
const windowsProvenanceName = 'desktop-release-windows.json';
const run = (command, args) => execFileSync(command, args, {
  cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const gh = (...args) => run('gh', args);
const api = (path, paginate = false) => JSON.parse(gh('api', `repos/${repository}/${path}`,
  ...(paginate ? ['--paginate', '--slurp'] : [])));
const git = (...args) => run('git', args);
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const jsonFile = (path) => JSON.parse(readFileSync(path, 'utf8'));

function versionParts(version) {
  requireThat(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version), 'Expected a stable X.Y.Z version');
  const parts = version.split('.').map(Number);
  requireThat(parts.every(Number.isSafeInteger), 'Version is out of range');
  return parts;
}

function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

function stableTagVersion(tag) {
  return /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag) ? tag.slice(1) : null;
}

function checkSha(sha) {
  requireThat(/^[a-f0-9]{40}$/.test(sha), 'Expected a full source commit SHA');
  requireThat(git('rev-parse', 'HEAD') === sha, 'Checkout does not match the tested source SHA');
}

function checkProductionHead(sha) {
  checkSha(sha);
  requireThat(api('git/ref/heads/main').object.sha === sha, 'Production moved; retry after the current main commit passes CI');
}

function productionCi(sha) {
  checkProductionHead(sha);
  const runs = api(`actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=${sha}&per_page=100`).workflow_runs;
  return runs.filter((r) => r.head_sha === sha && r.head_branch === 'main' &&
    r.event === 'push' && r.head_repository?.full_name === repository)
    .sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)[0];
}

function checkProduction(sha) {
  const latest = productionCi(sha);
  requireThat(latest?.status === 'completed' && latest.conclusion === 'success',
    'The current production SHA must have a successful push CI run');
}

// Tests inject the observation/clock; the CLI always reads trusted production CI.
export async function waitForProductionCi(sha, { inspect = productionCi, pause = () => delay(15_000), log = console.log } = {}) {
  let previous;
  for (;;) {
    const latest = inspect(sha);
    const state = latest ? `${latest.status}:${latest.conclusion ?? 'pending'}` : 'waiting-for-run';
    if (state !== previous) { log(`Production CI for ${sha}: ${state}`); previous = state; }
    if (latest?.status === 'completed') {
      requireThat(latest.conclusion === 'success', `Production CI did not succeed: ${latest.conclusion}`);
      return;
    }
    await pause();
  }
}

function allReleases() {
  return api('releases?per_page=100', true).flat();
}

function desktopInput(path) {
  if (path.endsWith('.md')) return false;
  return /^(apps\/(app-web|app-desktop|firefox-companion)\/|packages\/|scripts\/)/.test(path) ||
    ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'turbo.json',
      '.npmrc', '.github/workflows/desktop-release.yml'].includes(path);
}

function readProvenance(release) {
  if (!release.assets.some((a) => a.name === provenanceName)) return null;
  const value = JSON.parse(gh('release', 'download', release.tag_name, '--repo', repository,
    '--pattern', provenanceName, '--output', '-'));
  requireThat(value.schema === 1 && /^[a-f0-9]{40}$/.test(value.sha) &&
    value.version === stableTagVersion(release.tag_name) && value.platform === 'darwin' && value.arch === 'arm64',
  'Published desktop provenance is invalid');
  return value;
}

function outputPlan(value) {
  if (process.env.GITHUB_OUTPUT) {
    for (const [key, item] of Object.entries(value)) {
      requireThat(!String(item).includes('\n'), 'Invalid workflow output');
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${item}\n`);
    }
  }
  console.log(JSON.stringify(value));
}

function plan(sha, buildWhileCiRuns = false) {
  if (buildWhileCiRuns) checkProductionHead(sha);
  else checkProduction(sha);
  const releases = allReleases();
  const published = releases.filter((r) => !r.draft && !r.prerelease && stableTagVersion(r.tag_name) &&
    r.assets.some((a) => a.name === 'latest-mac.yml'))
    .sort((a, b) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)))[0];
  const previous = published && readProvenance(published);
  if (previous) {
    // A shallow/missing history must fail rather than quietly skip an update.
    git('merge-base', '--is-ancestor', previous.sha, sha);
    const changes = git('diff', '--name-only', '-z', previous.sha, sha, '--').split('\0');
    if (!changes.some(desktopInput)) return outputPlan({ release: false, sha, reason: 'Bundled inputs already published' });
  }
  const sourceVersion = jsonFile(resolve(root, 'apps/app-desktop/package.json')).version;
  const versions = [sourceVersion, ...releases.map((r) => stableTagVersion(r.tag_name)),
    ...api('tags?per_page=100', true).flat().map((t) => stableTagVersion(t.name))].filter(Boolean);
  const floor = versions.sort(compareVersions).at(-1);
  const [major, minor, patch] = versionParts(floor);
  const version = `${major}.${minor}.${patch + 1}`;
  versionParts(version);
  outputPlan({ release: true, sha, version });
}

function stamp(version, sha) {
  versionParts(version);
  checkSha(sha);
  const packagePath = resolve(root, 'apps/app-desktop/package.json');
  const pkg = jsonFile(packagePath);
  pkg.version = version;
  writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`Stamped desktop version ${version} for ${sha}`);
}

function artifact(name) {
  const path = resolve(releaseDir, name);
  const size = statSync(path).size;
  requireThat(size > 0, `Empty release artifact: ${name}`);
  const bytes = readFileSync(path);
  return { name, size, sha256: createHash('sha256').update(bytes).digest('hex'),
    sha512: createHash('sha512').update(bytes).digest('base64') };
}

function writeProvenance(name, version, sha, platform, arch, names) {
  const assets = names.map(artifact).map(({ sha512: _sha512, ...entry }) => entry);
  writeFileSync(resolve(releaseDir, name), JSON.stringify({
    schema: 1, version, sha, platform, arch, assets,
  }, null, 2) + '\n');
}

async function prepareMac(version, sha) {
  versionParts(version);
  checkSha(sha);
  requireThat(jsonFile(resolve(root, 'apps/app-desktop/package.json')).version === version,
    'The source package version must be set before building');
  // This dependency is only needed on the packaging runner, after frozen install.
  const { load, dump } = await import('js-yaml');
  const feedPath = resolve(releaseDir, 'latest-mac.yml');
  const feed = load(readFileSync(feedPath, 'utf8'));
  requireThat(feed?.version === version && Array.isArray(feed.files), 'Updater feed has the wrong version or shape');
  requireThat(feed.files.length === 2 && feed.files.some((f) => f.url === 'usebrian.zip') &&
    feed.files.some((f) => f.url === 'usebrian.dmg'), 'Updater feed must contain exactly the ZIP and DMG');
  const zip = artifact('usebrian.zip');
  const dmg = artifact('usebrian.dmg');
  const zipEntry = feed.files.find((f) => f.url === zip.name);
  requireThat(zipEntry.sha512 === zip.sha512 && zipEntry.size === zip.size &&
    feed.path === zip.name && feed.sha512 === zip.sha512, 'Updater ZIP checksum or size does not match the built archive');
  // Signing/stapling the DMG changes its bytes after electron-builder writes YAML.
  Object.assign(feed.files.find((f) => f.url === dmg.name), { sha512: dmg.sha512, size: dmg.size });
  writeFileSync(feedPath, dump(feed));
  writeProvenance(provenanceName, version, sha, 'darwin', 'arm64', macArtifactNames);
  console.log(`Verified macOS ${version} update artifacts for ${sha}`);
}

async function prepareWindows(version, sha) {
  versionParts(version);
  checkSha(sha);
  requireThat(jsonFile(resolve(root, 'apps/app-desktop/package.json')).version === version,
    'The source package version must be set before building');
  const { load } = await import('js-yaml');
  const feed = load(readFileSync(resolve(releaseDir, 'latest.yml'), 'utf8'));
  requireThat(feed?.version === version && Array.isArray(feed.files),
    'Windows updater feed has the wrong version or shape');
  requireThat(feed.files.length === 1 && feed.files[0].url === 'usebrian.exe',
    'Windows updater feed must contain exactly the NSIS installer');
  const exe = artifact('usebrian.exe');
  requireThat(feed.files[0].sha512 === exe.sha512 && feed.files[0].size === exe.size &&
    feed.path === exe.name && feed.sha512 === exe.sha512,
  'Windows updater checksum or size does not match the built installer');
  writeProvenance(windowsProvenanceName, version, sha, 'win32', 'x64', windowsArtifactNames);
  console.log(`Verified Windows ${version} update artifacts for ${sha}`);
}

function verifyPlatformArtifacts(manifestName, version, sha, platform, arch, names) {
  const manifest = jsonFile(resolve(releaseDir, manifestName));
  requireThat(manifest.schema === 1 && manifest.version === version && manifest.sha === sha &&
    manifest.platform === platform && manifest.arch === arch,
  `${platform} release provenance does not match the planned build`);
  requireThat(Array.isArray(manifest.assets) && manifest.assets.length === names.length &&
    names.every((name) => manifest.assets.filter((a) => a.name === name).length === 1),
  `${platform} release provenance must name exactly the required assets`);
  const assets = names.map(artifact);
  for (const actual of assets) {
    const expected = manifest.assets.find((a) => a.name === actual.name);
    requireThat(actual.size === expected.size && actual.sha256 === expected.sha256,
      `Release artifact changed after verification: ${actual.name}`);
  }
  return [...assets, artifact(manifestName)];
}

function verifyArtifacts(version, sha) {
  versionParts(version);
  return [
    ...verifyPlatformArtifacts(provenanceName, version, sha, 'darwin', 'arm64', macArtifactNames),
    ...verifyPlatformArtifacts(windowsProvenanceName, version, sha, 'win32', 'x64', windowsArtifactNames),
  ];
}

function verifyUploaded(release, assets) {
  for (const expected of assets) {
    const actual = release.assets.find((a) => a.name === expected.name);
    requireThat(actual?.state === 'uploaded' && actual.size === expected.size &&
      actual.digest === `sha256:${expected.sha256}`, `Uploaded artifact is missing or has a bad digest: ${expected.name}`);
  }
}

function checkNoNewerRelease(releases, version) {
  requireThat(!releases.some((r) => !r.draft && !r.prerelease && stableTagVersion(r.tag_name) &&
    compareVersions(r.tag_name.slice(1), version) > 0), 'A newer version was published; refusing to move latest backwards');
}

function reserveTag(tag, sha) {
  const existing = api('tags?per_page=100', true).flat().find((t) => t.name === tag);
  if (existing) {
    requireThat(existing.commit.sha === sha, 'Version tag is reserved for another source SHA');
  } else {
    // Read-only planners cannot see every draft. A tag reserves its version
    // publicly without changing the public release or any installed update feed.
    gh('api', '--method', 'POST', `repos/${repository}/git/refs`,
      '-f', `ref=refs/tags/${tag}`, '-f', `sha=${sha}`);
  }
}

function publish(version, sha) {
  const assets = verifyArtifacts(version, sha);
  checkProduction(sha);
  const releases = allReleases();
  checkNoNewerRelease(releases, version);
  const tag = `v${version}`;
  let release = releases.find((r) => r.tag_name === tag);
  if (release) {
    requireThat(release.target_commitish === sha, 'Release tag is reserved for another source SHA');
    if (!release.draft) {
      verifyUploaded(release, assets);
      console.log(`${tag} is already published; assets left unchanged`);
      return;
    }
  } else {
    reserveTag(tag, sha);
    gh('release', 'create', tag, '--repo', repository, '--target', sha, '--draft',
      '--verify-tag',
      '--title', `Use Brian ${tag}`, '--notes', `Desktop update built from production commit ${sha}.`);
  }
  gh('release', 'upload', tag, ...assets.map((a) => resolve(releaseDir, a.name)), '--repo', repository, '--clobber');
  // The tag endpoint is specified for published releases; look up drafts by id.
  const draft = allReleases().find((r) => r.tag_name === tag);
  requireThat(draft, 'Uploaded draft could not be found');
  release = api(`releases/${draft.id}`);
  requireThat(release.draft && release.target_commitish === sha, 'Release changed while uploading');
  requireThat(release.assets.length === assets.length, 'Draft contains unexpected release assets');
  verifyUploaded(release, assets);
  checkProduction(sha);
  checkNoNewerRelease(allReleases(), version);
  requireThat(api(`commits/${tag}`).sha === sha, 'Reserved tag does not match the tested commit');
  gh('release', 'edit', tag, '--repo', repository, '--draft=false', '--prerelease=false', '--latest');
  const published = api(`releases/tags/${tag}`);
  requireThat(!published.draft && !published.prerelease, 'Release did not become public');
  verifyUploaded(published, assets);
  requireThat(api(`commits/${tag}`).sha === sha, 'Published tag does not match the tested commit');
  console.log(`Published https://github.com/${repository}/releases/tag/${tag}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) try {
  const [command, value, sha] = process.argv.slice(2);
  if (command === 'plan') plan(value);
  else if (command === 'plan-build') plan(value, true);
  else if (command === 'wait-ci') await waitForProductionCi(value);
  else if (command === 'stamp') stamp(value, sha);
  else if (command === 'prepare') await prepareMac(value, sha);
  else if (command === 'prepare-windows') await prepareWindows(value, sha);
  else if (command === 'verify') verifyArtifacts(value, sha);
  else if (command === 'publish') publish(value, sha);
  else throw new Error('Usage: release.mjs plan SHA | plan-build SHA | wait-ci SHA | stamp VERSION SHA | prepare VERSION SHA | prepare-windows VERSION SHA | verify VERSION SHA | publish VERSION SHA');
} catch (error) {
  // Do not dump child-process buffers: external programs can echo credentials.
  console.error(error?.status !== undefined ? 'Release command failed; no further publication attempted.' : error.message);
  process.exitCode = 1;
}
