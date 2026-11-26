import type { ExecutionContext } from '@use-brian/agent-runtime/security/execution-context.js'
import { AuthorityChangedError } from '../context-scope/authority-lease.js'

type InitialReadEvidence = {
  checks: Map<string, () => Promise<void>>
  refused?: AuthorityChangedError
}

// Only an admitted read can attach a check to its original server execution.
// Model input and retained recipient output share the resulting refusal state.
const evidenceByExecution = new WeakMap<ExecutionContext, InitialReadEvidence>()

export function retainInitialReadEvidence(execution: ExecutionContext, key: string, check: () => Promise<void>): void {
  const evidence: InitialReadEvidence = evidenceByExecution.get(execution) ?? { checks: new Map() }
  if (evidence.refused) throw evidence.refused
  if (!evidence.checks.has(key)) evidence.checks.set(key, check)
  evidenceByExecution.set(execution, evidence)
}

export async function assertInitialReadEvidenceCurrent(execution: ExecutionContext | undefined): Promise<void> {
  const evidence = execution && evidenceByExecution.get(execution)
  if (!evidence) return
  if (evidence.refused) throw evidence.refused
  try {
    await Promise.all(Array.from(evidence.checks.values(), check => check()))
  } catch {
    evidence.refused ??= new AuthorityChangedError()
  }
  if (evidence.refused) throw evidence.refused
}

export function closeInitialReadEvidence(execution: ExecutionContext | undefined): void {
  const evidence = execution && evidenceByExecution.get(execution)
  if (!evidence) return
  evidence.checks.clear()
  evidence.refused ??= new AuthorityChangedError()
}
