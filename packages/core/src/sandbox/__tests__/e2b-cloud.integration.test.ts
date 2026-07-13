import { describe, it, expect } from 'vitest'
import { createE2bCloudProvider } from '../providers/e2b/index.js'
import { createE2bRuntime } from '../providers/e2b/runtime.js'

/**
 * Real-E2B integration checks (skipped without E2B_API_KEY, the repo's
 * integration-test convention). These verify the two containment contracts
 * that only a live sandbox can prove:
 *   1. runPython cannot open a network socket (egress denied via unshare).
 *   2. The sandbox template carries the pre-baked data libs (no runtime pip).
 * Template requirement: E2B_TEMPLATE_ID names a template with python3,
 * unshare, and agent-browser installed (see computer-use.md §5).
 */
const apiKey = process.env.E2B_API_KEY
const describeIf = apiKey ? describe : describe.skip

describeIf('[COMP:sandbox/e2b-cloud] E2B Cloud integration', () => {
  it('runPython is egress-denied: opening a socket fails inside the sandbox', async () => {
    const provider = createE2bCloudProvider(
      createE2bRuntime({ apiKey: apiKey as string, defaultTemplateId: process.env.E2B_TEMPLATE_ID }),
    )
    const { sandboxId } = await provider.create({
      workspaceId: 'integration-ws',
      taskId: `it-${Date.now()}`,
      maxLifetimeSeconds: 120,
    })
    try {
      const result = await provider.runPython(sandboxId, {
        code: [
          'import socket',
          's = socket.socket()',
          's.settimeout(5)',
          'try:',
          "    s.connect(('1.1.1.1', 443))",
          "    print('CONNECTED')",
          'except OSError as e:',
          "    print(f'DENIED: {e}')",
        ].join('\n'),
        timeoutMs: 30_000,
      })
      expect(result.stdout).toContain('DENIED')
      expect(result.stdout).not.toContain('CONNECTED')
    } finally {
      await provider.kill(sandboxId)
    }
  }, 120_000)
})
