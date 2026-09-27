import { readFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createLocalFixture, runCommand, cleanRuntimeEnvironment, validateAmbientDatabase } from './crm/local-fixture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
let pgBin = process.env.BRIAN_TEST_PG_BIN
let foundation = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--foundation') foundation = true
  else if (args[i] === '--pg-bin' && args[i + 1]) pgBin = args[++i]
  else throw new Error(`Unknown or incomplete option: ${args[i]}`)
}

async function run() {
  validateAmbientDatabase(process.env)
  if (!foundation) throw new Error('The full A01-A18 lifecycle runner is not yet complete. --foundation runs only the implemented foundation suites; strict activation remains unavailable.')
  const fixture = await createLocalFixture({ pgBin })
  try {
    const reports = join(fixture.directory, 'reports')
    await mkdir(reports)
    const env = { ...cleanRuntimeEnvironment(process.env), ...fixture.env, CONTEXT_SCOPE_TEST_DATABASE_URL: fixture.adminUrl }
    const suites = [
      { name: 'kernel', cwd: join(root, 'packages/core'), config: [], paths: ['src/security/__tests__/access-ceiling.test.ts', 'src/security/__tests__/derived-scope.test.ts', 'src/security/__tests__/source-evidence.test.ts', 'src/security/__tests__/context-scope.test.ts', 'src/consolidation/__tests__/department-isolation.test.ts', 'src/consolidation/__tests__/consolidation.test.ts', 'src/consolidation/__tests__/bi-temporal-filter.test.ts'] },
      { name: 'store', cwd: join(root, 'packages/api'), config: ['--config', 'vitest.integration.config.ts'], paths: ['src/db/__tests__/derived-scope-store.integration.test.ts','src/db/__tests__/delegated-visibility.integration.test.ts'] },
      { name: 'entity-mutation', cwd: join(root, 'packages/api'), config: ['--config', 'vitest.integration.config.ts'], paths: ['src/db/__tests__/entity-mutation-scope.integration.test.ts'] },
      { name: 'crm-activity-scope', cwd: join(root, 'packages/api'), config: ['--config', 'vitest.integration.config.ts'], paths: ['src/db/__tests__/crm-activity-scope.integration.test.ts'] },
      { name: 'crm-tools', cwd: join(root, 'packages/core'), config: [], paths: ['src/crm/__tests__/tools.test.ts'] },
      { name: 'crm-participants-ui', cwd: join(root, 'apps/app-web'), config: [], paths: ['src/components/crm/__tests__/crm-participants.test.tsx'] },
      { name: 'crm-activity-ui', cwd: join(root, 'apps/app-web'), config: [], paths: ['src/components/crm/__tests__/crm-activity.test.tsx'] },
      { name: 'file-mutation', cwd: join(root, 'packages/api'), config: ['--config', 'vitest.integration.config.ts'], paths: ['src/db/__tests__/file-mutation-scope.integration.test.ts'] },
      { name: 'task-mutation', cwd: join(root, 'packages/api'), config: ['--config', 'vitest.integration.config.ts'], paths: ['src/db/__tests__/task-mutation-scope.integration.test.ts'] },
      { name: 'task-tools', cwd: join(root, 'packages/core'), config: [], paths: ['src/tasks/__tests__/tools.test.ts','src/tasks/__tests__/guardrail-tools.test.ts'] },
      { name: 'memory-mutation-regression', cwd: join(root, 'packages/api'), config: ['--config', 'vitest.integration.config.ts'], paths: ['src/db/__tests__/memories-supersession.integration.test.ts','src/db/__tests__/memories-primary-workspace-shared.integration.test.ts'] },
      { name: 'brain-mutation', cwd: join(root, 'packages/api'), config: ['--config', 'vitest.integration.config.ts'], paths: ['src/db/__tests__/brain-mutation-scope.integration.test.ts'] },
      { name: 'memory-tools', cwd: join(root, 'packages/core'), config: [], paths: ['src/memory/__tests__/memory-tools.test.ts'] },
      { name: 'reflection-evidence', cwd: join(root, 'packages/api'), config: ['--config', 'vitest.integration.config.ts'], paths: ['src/db/__tests__/reflection-evidence.integration.test.ts'] },
      { name: 'reader-source-evidence', cwd: join(root, 'packages/api'), config: ['--config', 'vitest.integration.config.ts'], paths: ['src/db/__tests__/reader-source-evidence.integration.test.ts'] },
      { name: 'identity-context', cwd: join(root, 'packages/api'), config: ['--config', 'vitest.integration.config.ts'], paths: ['src/db/__tests__/identity-context.integration.test.ts'] },
      { name: 'handoff', cwd: join(root, 'packages/core'), config: [], paths: ['src/tools/__tests__/ask-assistant.test.ts'] },
      { name: 'audit-scope', cwd: join(root, 'packages/api'), config: ['--config', 'vitest.integration.config.ts'], paths: ['src/db/__tests__/audit-scope.integration.test.ts'] },
      { name: 'goal-crm-scope', cwd: join(root, 'packages/api'), config: ['--config', 'vitest.integration.config.ts'], paths: ['src/goals/__tests__/crm-event-resume.integration.test.ts'] },
      { name: 'crm-event-scope', cwd: join(root, 'packages/api'), config: ['--config', 'vitest.integration.config.ts'], paths: ['src/context-scope/__tests__/crm-event-scope.integration.test.ts'] },
      { name: 'workflow-input-evidence', cwd: join(root, 'packages/api'), config: ['--config', 'vitest.integration.config.ts'], paths: ['src/context-scope/__tests__/workflow-input-evidence.integration.test.ts'] },
      { name: 'workflow-authority', cwd: join(root, 'packages/api'), config: ['--config', 'vitest.integration.config.ts'], paths: ['src/context-scope/__tests__/workflow-authority.integration.test.ts'] },
      { name: 'execution-read-ceiling', cwd: join(root, 'packages/api'), config: ['--config', 'vitest.integration.config.ts'], paths: ['src/db/__tests__/execution-read-ceiling.integration.test.ts'] },
      { name: 'caller-evidence', cwd: join(root, 'packages/api'), config: ['--config', 'vitest.integration.config.ts'], paths: ['src/context-scope/__tests__/caller-evidence.integration.test.ts'] },
      { name: 'workflow-executor', cwd: join(root, 'packages/core'), config: [], paths: ['src/workflow/__tests__/executor.test.ts'] },
      { name: 'workflow-boundaries', cwd: join(root, 'packages/api'), config: [], paths: ['src/workflow/__tests__/approval.test.ts','src/workflow/__tests__/mcp-bridge.test.ts','src/db/__tests__/external-principal-scope.test.ts'] },
      { name: 'authority-runtime', cwd: join(root, 'packages/api'), config: [], paths: ['src/context-scope/__tests__/authority-lease.test.ts','src/context-scope/__tests__/agent-access-tools.test.ts','src/context-scope/__tests__/resolve-turn-scope.test.ts','src/inter-assistant/__tests__/executor.test.ts'] },
      { name: 'connector-mutation', cwd: join(root, 'packages/api'), config: [], paths: ['src/context-scope/__tests__/connector-exposure.test.ts','src/mcp/__tests__/inject.test.ts','src/structured-documents/__tests__/connector.test.ts','src/structured-documents/__tests__/service.test.ts','src/structured-documents/__tests__/tools.test.ts'] },
      { name: 'native-delivery', cwd: join(root, 'packages/api'), config: ['--config', 'vitest.integration.config.ts'], paths: ['src/db/__tests__/crm-delivery-receipts.integration.test.ts'] },
      { name: 'native-delivery-tools', cwd: join(root, 'packages/core'), config: [], paths: ['src/crm/__tests__/operations-tools.test.ts'] },
      { name: 'organization', cwd: join(root, 'packages/api'), config: ['--config', 'vitest.integration.config.ts'], paths: ['src/workspace-access/__tests__/org-chart.integration.test.ts','src/workspace-access/__tests__/organization-command-review.integration.test.ts'] },
      { name: 'access-policy', cwd: join(root, 'packages/api'), config: [], paths: ['src/workspace-access/__tests__/policy.test.ts','src/workspace-access/__tests__/tools.test.ts','src/workspace-access/__tests__/readiness.test.ts'] },
      { name: 'read-grants', cwd: join(root, 'packages/api'), config: ['--config', 'vitest.integration.config.ts'], paths: ['src/workspace-access/__tests__/read-grants.integration.test.ts','src/workspace-access/__tests__/service.integration.test.ts','src/workspace-access/__tests__/command-review.integration.test.ts','src/workspace-access/__tests__/history.integration.test.ts'] },
      { name: 'scope-review', cwd: join(root, 'packages/api'), config: ['--config', 'vitest.integration.config.ts'], paths: ['src/workspace-access/__tests__/scope-review.integration.test.ts'] },
    ]
    let executed = 0
    for (const suite of suites) {
      const outputFile = join(reports, `${suite.name}.json`)
      await runCommand('pnpm', ['exec', 'vitest', 'run', ...suite.config, ...suite.paths, '--reporter=default', '--reporter=json', `--outputFile=${outputFile}`], { cwd: suite.cwd, env, inherit: true })
      const report = JSON.parse(await readFile(outputFile, 'utf8'))
      const assertions = report.testResults.flatMap(result => result.assertionResults)
      if (!assertions.length || assertions.some(assertion => assertion.status !== 'passed')) {
        throw new Error(`${suite.name}: zero, skipped, pending, or failed tests are not acceptance`)
      }
      executed += assertions.length
    }
    const revision = (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: root, env })).trim()
    console.log(JSON.stringify({ slice: 'foundation', revision, executed, skipped: 0, fullMatrixAccepted: false }))
  } finally { await fixture.dispose() }
}
run().catch(error => { console.error(error.message); process.exitCode = 1 })
