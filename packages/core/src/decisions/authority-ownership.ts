/** Private classifier boundary ownership, never permission receipts. [COMP:decisions/hydra] */
import { assertInputAuthority } from '../providers/input-authority.js'
import type { DecisionExecutionPort, DecisionCompletionRoute, DecisionExecutionOperation, DecisionCascadeResult } from './hydra.js'
import type { DecisionRequest } from './types.js'

type Check = () => Promise<void>
type Operation = { assertInputAuthority?: Check; decide: unknown; validateResult: unknown; safeFailure: unknown; completeWithLlm: unknown }
type Boundary = { active: Check; enabled: boolean; completion?: object }
const keys = ['assertInputAuthority', 'decide', 'validateResult', 'safeFailure', 'completeWithLlm'] as const
const runtimes = new WeakMap<DecisionExecutionPort, DecisionExecutionPort['run']>()
const sinks = new WeakSet<object>()
const operations = new WeakMap<object, { boundary: Boundary; calls: Operation }>()
const checks = new WeakMap<Check, Boundary>()
const requests = new WeakMap<DecisionRequest, { boundary: Boundary; check: Check | undefined }>()
type Completion = { identity: object; calls: Operation; qualify: (route: DecisionCompletionRoute, request: Pick<DecisionRequest, 'state' | 'questions'>) => boolean; qualified?: () => void; inputCapacityFallback: boolean }
const completions = new WeakMap<object, Completion>()

/** Only fixed domain completion factories enroll their captured pure callbacks. */
export function registerClassifierLlmCompletion<T extends Operation>(operation: T,
  qualify: Completion['qualify'], options?: { qualified?: () => void; inputCapacityFallback?: boolean }): T {
  completions.set(operation, { identity: {}, calls: { ...operation }, qualify, qualified: options?.qualified, inputCapacityFallback: options?.inputCapacityFallback === true })
  return operation
}
function completion(operation: Operation): Completion | undefined {
  const entry = completions.get(operation)
  return entry && keys.every(key => entry.calls[key] === operation[key]) ? entry : undefined
}
/** The runtime calls this only after pinning the actual resolved LLM route. */
export function qualifyClassifierLlmCompletion(operation: Operation, route: DecisionCompletionRoute, request: Pick<DecisionRequest, 'state' | 'questions'>): boolean {
  const boundary = owned(operation), entry = completion(operation)
  if (boundary) boundary.completion = undefined
  if (!boundary?.enabled || !entry || !entry.qualify(route, request)) return false
  boundary.completion = entry.identity
  entry.qualified?.()
  return true
}
export function ownsClassifierLlmCompletion(operation: Operation): boolean {
  const boundary = owned(operation), entry = completion(operation)
  return !!boundary?.enabled && !!entry && boundary.completion === entry.identity
}
export function ownsClassifierCapacityFallback(operation: Operation): boolean {
  return ownsClassifierLlmCompletion(operation) && completion(operation)?.inputCapacityFallback === true
}
// Static no-inference deferrals are bound to one fixed completion invocation.
// This is not source authority and is never accepted by a provider or writer.
const capacityDeferrals = new WeakMap<object, object>()
export function createClassifierCapacityDeferral<T>(operation: DecisionExecutionOperation<T>, runId: string): DecisionCascadeResult<T> {
  if (!ownsClassifierCapacityFallback(operation)) throw new Error('Unowned classifier capacity deferral')
  const result = Object.freeze({ runId, result: operation.validateResult(operation.safeFailure('unsupported_capability')),
    path: 'capacity_deferred' as const, attempts: 0 })
  capacityDeferrals.set(result, completion(operation)!.identity)
  return result
}
export function consumeClassifierCapacityDeferral(operation: Operation, result: object): boolean {
  const entry = completion(operation)
  if (!entry || capacityDeferrals.get(result) !== entry.identity) return false
  capacityDeferrals.delete(result)
  return true
}

/** Audited wrappers preserve callback ancestry, not a successful allow result. */
export function transferClassifierDecisionCheck(source: Check | undefined, target: Check): Check {
  const boundary = source && checks.get(source)
  if (boundary) checks.set(target, boundary)
  return target
}
export function sharesClassifierCompletionAdmission(a: Check | undefined, b: Check | undefined): boolean {
  const boundary = a && checks.get(a)
  return !!boundary?.enabled && !!boundary.completion && !!b && checks.get(b) === boundary
}

/** The API factory registers only runtimes with captured, audited metadata hooks. */
export function registerClassifierDecisionRuntime<T extends DecisionExecutionPort>(runtime: T): T {
  runtimes.set(runtime, runtime.run)
  return runtime
}

/** Only fixed-schema accounting factories register their exact callback. */
export function registerDecisionMetadataSink<T extends (...args: never[]) => unknown>(sink: T): T {
  sinks.add(sink)
  return sink
}
export function isDecisionMetadataSink(sink: unknown): boolean {
  return sink === undefined || typeof sink === 'function' && sinks.has(sink)
}

function owned(operation: Operation): Boundary | undefined {
  const entry = operations.get(operation)
  return entry && keys.every(key => entry.calls[key] === operation[key]) ? entry.boundary : undefined
}

/** Classifier-only entry: capture methods before an await and pin local callbacks. */
export function captureClassifierDecisionRuntime(runtime: DecisionExecutionPort | undefined, full: Check, active: Check): DecisionExecutionPort | undefined {
  if (!runtime) return undefined
  const run = runtime.run, observe = runtime.observe
  if (runtimes.get(runtime) !== run) return { run: run.bind(runtime), observe: observe.bind(runtime) }
  const boundary: Boundary = { active, enabled: true }
  const capturedRun = run.bind(runtime)
  checks.set(full, boundary)
  return {
    run(options) {
      const operation = { ...options.operation }
      operations.set(operation, { boundary, calls: { ...operation } })
      const entry = completion(options.operation)
      if (entry) completions.set(operation, { ...entry, calls: { ...operation } })
      return capturedRun({ ...options, operation })
    },
    observe: observe.bind(runtime),
  }
}

/** Known wrappers explicitly carry ownership onto captured replacement closures. */
export function transferClassifierDecisionOperation<T extends Operation>(source: Operation, target: T): T {
  const boundary = owned(source)
  if (boundary) {
    operations.set(target, { boundary, calls: { ...target } })
    if (target.assertInputAuthority) checks.set(target.assertInputAuthority, boundary)
  }
  const entry = completion(source)
  if (entry) completions.set(target, { ...entry, calls: { ...target } })
  return target
}
export function ownsClassifierDecisionOperation(operation: Operation): boolean {
  return owned(operation)?.enabled === true
}
export function disableClassifierDecisionOperation(operation: Operation): void {
  const boundary = owned(operation)
  if (boundary) boundary.enabled = false
}
export async function assertClassifierBookkeeping(check?: Check): Promise<void> {
  const boundary = check && checks.get(check)
  if (boundary?.enabled) await boundary.active()
  else await assertInputAuthority(check)
}
export async function assertDecisionBookkeeping(operation: Operation, full: Check): Promise<void> {
  const boundary = owned(operation)
  if (boundary?.enabled) await boundary.active()
  else await full()
}

/** Bind only the actual request sent to a captured, registered fetch adapter. */
export function bindClassifierDecisionRequest<T extends DecisionRequest>(operation: Operation, request: T): T {
  const boundary = owned(operation)
  if (boundary?.enabled) requests.set(request, { boundary, check: request.assertInputAuthority })
  return request
}
export async function assertDecisionResponseAuthority(request: DecisionRequest): Promise<void> {
  const entry = requests.get(request)
  if (entry?.boundary.enabled && entry.check === request.assertInputAuthority) await entry.boundary.active()
  else await assertInputAuthority(request.assertInputAuthority)
}
