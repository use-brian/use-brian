// [COMP:ci/execution-topology] Acceptance owns these files in CI. Local package
// tests stay complete unless the caller explicitly selects the ordinary partition.
import { DEPARTMENT_ISOLATION_SUITES } from '../../packages/shared/src/department-isolation-coverage.ts'
import { fastCheckTestFiles } from './run-fast-checks.mjs'

// The workflow topology test requires exact agreement with its mandatory offline commands.
/** @type {Record<string, string[]>} */
export const OFFLINE_CONTINUITY_FILES = {
  "apps/app-web": [
    "src/lib/__tests__/app-session.test.ts",
    "src/components/__tests__/app-session.test.tsx",
    "src/components/context/__tests__/mode-aware-context.test.tsx",
    "src/components/chat-app/__tests__/chat-responsive-controls.test.tsx",
    "src/lib/__tests__/auth-fetch.test.ts",
    "desktop/__tests__/offline-bootstrap.test.ts",
    "src/lib/offline/__tests__/offline-pages.test.ts",
    "src/contexts/__tests__/primary-assistant-offline.test.tsx",
    "src/lib/offline/__tests__/durable-draft.test.tsx",
    "src/components/doc/__tests__/comment-thread-body-seed.test.tsx",
    "src/components/doc/__tests__/page-comments.test.tsx",
    "src/lib/offline/__tests__/metadata-recovery.test.ts",
    "src/lib/offline/__tests__/application-authority-cache.test.ts",
    "src/lib/recordings/__tests__/offline-media.test.ts",
    "src/lib/recordings/__tests__/upload-journal.test.ts",
    "src/lib/recordings/__tests__/upload-restart.test.ts",
    "src/lib/recordings/__tests__/use-recording-upload.test.tsx",
    "src/lib/recorder/__tests__/recorder-spool.test.ts",
    "src/lib/recorder/__tests__/dock-recorder-background.test.tsx",
    "src/lib/offline/__tests__/offline-writes.test.ts",
    "src/lib/offline/__tests__/use-offline-sync.test.ts",
    "src/lib/recorder/__tests__/recorder-engine-live.test.ts",
    "src/lib/recordings/__tests__/recording-player-context.test.tsx",
    "src/components/recordings/__tests__/recording-player-bar.test.tsx"
  ],
  "apps/app-desktop": [
    "src/__tests__/desktop-auth.test.ts",
    "src/__tests__/window-policy.test.ts",
    "src/__tests__/desktop-token-store.test.ts",
    "src/__tests__/desktop-packaging.test.ts"
  ]
}

/** @param {string} packageDir @param {string | undefined} partition */
export function unitTestExclusions(packageDir, partition = process.env.BRIAN_TEST_PARTITION) {
  if (!partition) return []
  if (partition !== 'ordinary') throw new Error(`Unknown test partition: ${partition}`)
  return [...new Set([
    ...DEPARTMENT_ISOLATION_SUITES.filter(suite => suite.packageDir === packageDir).flatMap(suite => suite.testFiles),
    ...(OFFLINE_CONTINUITY_FILES[packageDir] ?? []),
    ...fastCheckTestFiles(packageDir),
  ])]
}
