import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const root = fileURLToPath(new URL('../../', import.meta.url))
const sharedInputs = [
  'apps/app-web/package.json',
  'package.json',
  'packages/api/package.json',
  'packages/api/src/routes/__tests__/helpers.ts',
  'packages/api/vitest.config.ts',
  'packages/api/vitest.setup.ts',
  'packages/shared/package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts/hooks/after-edit-fast-checks.mjs',
  'scripts/testing/run-fast-checks.mjs',
  'scripts/testing/unit-partition.mjs',
]
const checks = new Map([
  ['teamspaces-contract', {
    packageDir: 'packages/api',
    suite: 'src/routes/__tests__/teamspaces-contract.test.mjs',
    inputs: [
      'apps/app-web/src/components/doc/doc-sidebar-data.tsx',
      'apps/app-web/src/components/doc/teamspace-settings-modal.tsx',
      'apps/app-web/src/lib/api/teamspaces.ts',
      'packages/agent-runtime/src/security/sensitivity.ts',
      'packages/api/src/db/teamspace-store.ts',
      'packages/api/src/routes/teamspaces.ts',
      'packages/shared/src/teamspaces.ts',
    ],
  }],
  ['home-dock-contract', {
    packageDir: 'packages/api',
    suite: 'src/routes/__tests__/home-dock-contract.test.mjs',
    inputs: [
      'apps/app-web/src/lib/api/home-dock.ts',
      'packages/api/src/routes/home-dock.ts',
      'packages/core/package.json',
      'packages/core/src/home/merge.ts',
      'packages/core/src/home/types.ts',
      'packages/shared/src/home-dock.ts',
    ],
  }],
])

/** Complete suites that CI can exclude from ordinary testing after running the fast checks. */
export function fastCheckTestFiles(packageDir) {
  return [...checks.values()].filter(check => check.packageDir === packageDir).map(check => check.suite)
}

export function selectFastChecks(changedFiles) {
  const paths = new Set(changedFiles.map(file => relative(root, resolve(root, file)).split(sep).join('/')))
  if (sharedInputs.some(file => paths.has(file))) return [...checks.keys()]
  return [...checks].filter(([, check]) =>
    paths.has(`${check.packageDir}/${check.suite}`) || check.inputs.some(file => paths.has(file)),
  ).map(([id]) => id)
}

const usage = `Usage: pnpm check:fast --all
       pnpm check:fast --check <${[...checks.keys()].join('|')}>
       pnpm check:fast --changed-file <OSS-relative or absolute path> [--changed-file <path> ...]`

function runCheck(id, { writeOutput, writeError, deadline, timeoutMs }) {
  const check = checks.get(id)
  if (!check) throw new Error(`Unknown fast check ${JSON.stringify(id)}.`)
  const { packageDir, suite } = check
  const cwd = join(root, packageDir)
  let vitest
  try {
    // Use the package's installed runner with the same Node as the hook or CI.
    vitest = createRequire(join(cwd, 'package.json')).resolve('vitest/vitest.mjs')
  } catch (error) {
    throw new Error(`${id} requires Vitest in ${packageDir}. Run pnpm install --frozen-lockfile from the OSS root.`, { cause: error })
  }

  writeOutput(`Running ${id}\n`)
  const result = spawnSync(process.execPath, [vitest, 'run', suite, '--maxWorkers=1', '--pool=threads'], {
    cwd,
    env: { ...process.env, BRIAN_TEST_PARTITION: '' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: deadline === undefined ? undefined : Math.max(1, deadline - Date.now()),
    killSignal: 'SIGKILL',
  })
  if (result.stdout) writeOutput(result.stdout)
  if (result.stderr) writeError(result.stderr)
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`${id} timed out within the ${timeoutMs} ms fast-check budget. Rerun pnpm check:fast --check ${id}.`)
  }
  if (result.error) throw result.error
  if (result.status !== 0) {
    writeError(`${id} failed${result.signal ? ` (${result.signal})` : ''}. Review ${packageDir}/${suite} and rerun pnpm check:fast --check ${id}.\n`)
  }
  return result.status ?? 1
}

/** Run the selected suites for the CLI or an editor hook, returning the first failure status. */
export function runFastChecks(selected, {
  writeOutput = text => process.stdout.write(text),
  writeError = text => process.stderr.write(text),
  timeoutMs,
} = {}) {
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs
  for (const id of selected) {
    try {
      const status = runCheck(id, { writeOutput, writeError, deadline, timeoutMs })
      if (status !== 0) return status
    } catch (error) {
      writeError(`${error.message}\n`)
      return 1
    }
  }
  return 0
}

function main(args) {
  let selected
  try {
    const { values } = parseArgs({ args, options: {
      all: { type: 'boolean' },
      check: { type: 'string', multiple: true },
      'changed-file': { type: 'string', multiple: true },
      help: { type: 'boolean' },
    } })
    if (values.help) {
      console.log(usage)
      return 0
    }
    const { all, check: named, 'changed-file': changed } = values
    if (all && !named && !changed) {
      selected = [...checks.keys()]
    } else if (!all && named?.length === 1 && !changed) {
      if (!checks.has(named[0])) throw new Error(`Unknown fast check ${JSON.stringify(named[0])}.`)
      selected = named
    } else if (!all && !named && changed?.every(Boolean)) {
      selected = selectFastChecks(changed)
    } else {
      throw new Error('Choose one mode: --all, --check, or one or more --changed-file options.')
    }
  } catch (error) {
    console.error(`${error.message}\n${usage}`)
    return 2
  }

  return runFastChecks(selected)
}

if (import.meta.main ?? (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  process.exitCode = main(process.argv.slice(2))
}
