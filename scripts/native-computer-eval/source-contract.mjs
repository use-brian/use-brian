// Load the AUTHORITATIVE repository source, never a stale dist or a copied
// evaluator schema. No user-selected module path enters this loader.
// Node >=22.13 transform support and the core workspace's installed zod are
// required for this optional source observer; offline/synthetic tools stay free
// of this dependency. No generated files or runtime sources are modified.
import { readFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
async function loadContract(sourceUrl) {
  const source = readFileSync(sourceUrl, 'utf8');
  const zodUrl = pathToFileURL(createRequire(sourceUrl).resolve('zod')).href;
  const transformed = stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: sourceUrl.href });
  const imports = [...transformed.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
  if (imports.filter(x => x === 'zod').length !== 1 || imports.some(x => x !== 'zod' && !x.startsWith('node:'))) throw new Error('Source contract unavailable');
  const executable = transformed.replace(/from\s+(['"])zod\1/, `from ${JSON.stringify(zodUrl)}`);
  const contract = await import(`data:text/javascript;base64,${Buffer.from(executable).toString('base64')}`);
  return { contract, digest: createHash('sha256').update(source).digest('hex') };
}
const core = await loadContract(new URL('../../packages/core/src/computer-use/trace.ts', import.meta.url));
const helper = await loadContract(new URL('../../packages/computer-control/src/helper-timing.ts', import.meta.url));
const broker = await loadContract(new URL('../../packages/computer-control/src/broker-trace.ts', import.meta.url));
export const { NativeBrokerTraceEventSchema, NativeTraceBindingSchema } = broker.contract;
export const brokerContractDigest = broker.digest;
export const { NativeTraceEventSchema, NativeInferenceLifecycleSchema, NativeRunTrace } = core.contract;
export const { HelperTimingSchema, HelperMethodSchema, HelperTimingEventSchema } = helper.contract;
export const sourceContractDigest = core.digest;
export const helperContractDigest = helper.digest;
export const sourceUuidSchema = NativeTraceEventSchema.innerType().shape.runId;

const passive = await loadContract(new URL('../../packages/computer-control/src/passive-observer.ts', import.meta.url));
export const { PassiveObserverHealthSchema } = passive.contract;
