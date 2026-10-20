/** Deterministic, fail-closed kit generators. [COMP:shared/brian-app-sdk] */
import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
export type ScaffoldProfile = 'native' | 'connector'

const nativeModule = `import { ApplicationSdkError } from '@use-brian/brian-app/application'
import type { ApplicationModuleDefinition, ApplicationRegisteredOperation, ApplicationRegisteredCommand, defineApplicationModules } from '@use-brian/brian-app/module'

// Bind these ports to canonical storage, current ACL and result admission in the deployed host.
export interface NativePorts<T> {
  query: ApplicationRegisteredOperation<T>
  command: ApplicationRegisteredCommand<T>
}
export function createNativeModule<T>(ports?: NativePorts<T>): ApplicationModuleDefinition<T> {
  if (!ports?.query?.authorize || !ports.query.authorizeResult || !ports.command?.authorize || !ports.command.authorizeResult) throw new ApplicationSdkError('operation_not_available')
  return { key: 'example_module', defaultState: 'disabled',
    application: { version: '1', dependencies: [], resources: [{ typeKey: 'example_record', origin: { kind: 'native', moduleKey: 'example_module' }, schemaVersion: '1', fields: [{ key: 'title', label: 'Title', kind: 'text' }] }], queries: ['lookup'], commands: ['change'], events: ['example.changed'],
      policyCapabilities: [], backgroundHandlers: [], uiContributions: [] },
    queries: { lookup: ports.query }, commands: { change: ports.command } }
}
export function registerNativeModule<T>(register: typeof defineApplicationModules<T>, existing: Parameters<typeof defineApplicationModules<T>>[1], ports: NativePorts<T>) {
  // The host injects core's canonical deployed registrar. No database/upload registration or local allowlist.
  return register([createNativeModule(ports)], existing)
}
`
const nativeBrowser = `import { createApplicationClient, createFetchTransport, createHomeApplicationTransport } from '@use-brian/brian-app/application'
export function standalone(appId: string, apiOrigin: string, appOAuth: Parameters<typeof createFetchTransport>[0]['credential']) {
  return createApplicationClient({ appId, transport: createFetchTransport({ apiOrigin, credential: appOAuth }) })
}
export function home(options: Parameters<typeof createHomeApplicationTransport>[0]) {
  const bridge = createHomeApplicationTransport(options)
  return { client: createApplicationClient({ appId: options.appId, transport: bridge.transport }), dispose: bridge.dispose }
}
`
const connectorSource = `import { createConnectorActorVerifier, authorizeConnectorRequest, handleSourceSidecar, SourceProtocolError,
  type ConnectorActorClaims, type ConnectorRequestBytes, type SourceSidecarPorts } from '@use-brian/brian-app/connector'

export interface SourcePorts {
  // Durable atomic replay storage and configured trusted public keys are required.
  verifier: Parameters<typeof createConnectorActorVerifier>[0]
  authenticateTransport: () => Promise<boolean>
  source: SourceSidecarPorts
  authorizeCommand: (actor: Readonly<ConnectorActorClaims>, input: unknown) => Promise<{ allowed: false } | { allowed: true; value: unknown }>
  // Canonical source transaction: current ACL, saved idempotency key, effect receipt, reconciliation/evidence.
  command: (actor: Readonly<ConnectorActorClaims>, idempotencyKey: string, input: unknown) => Promise<unknown>
}
export function createConnectorSource(ports?: SourcePorts) {
  const required = () => {
    if (!ports?.verifier?.consumeReplay || !ports.authenticateTransport || !ports.source?.capabilities || !ports.source.authorize || !ports.source.reconcile
      || !ports.authorizeCommand || !ports.command) throw new SourceProtocolError('source_unavailable')
    return ports
  }
  const verifier = ports ? createConnectorActorVerifier(ports.verifier) : undefined
  return {
    async sidecar(endpoint: 'capabilities' | 'authorize' | 'reconcile', request: ConnectorRequestBytes, assertion: string) {
      const configured = required()
      return handleSourceSidecar({ endpoint, request, assertion, authenticateTransport: configured.authenticateTransport, verifyActor: verifier! }, configured.source)
    },
    async command(request: ConnectorRequestBytes, assertion: string) {
      const configured = required()
      if (request.method !== 'POST' || request.body.byteLength > 512 * 1024) throw new SourceProtocolError('source_protocol_invalid')
      let key = ''
      const authorized = await authorizeConnectorRequest({ request, assertion, authenticateTransport: configured.authenticateTransport, verifyActor: verifier!,
        authorize: async actor => {
          let body: { idempotencyKey?: unknown; input?: unknown }
          try { body = JSON.parse(new TextDecoder().decode(request.body)) } catch { throw new SourceProtocolError('source_protocol_invalid') }
          if (typeof body.idempotencyKey !== 'string' || !body.idempotencyKey || body.idempotencyKey.length > 128) throw new SourceProtocolError('source_protocol_invalid')
          key = body.idempotencyKey
          return configured.authorizeCommand(actor, body.input)
        } })
      // No retry. The source command owns the transaction and must reconcile uncertain effects.
      return configured.command(authorized.actor, key, authorized.value)
    },
  }
}
`
export function scaffoldFiles(profile: ScaffoldProfile): Readonly<Record<string,string>> {
  if (profile !== 'native' && profile !== 'connector') throw new Error('Unknown scaffold profile')
  const manifest = { name: `brian-application-${profile}`, version: '0.0.0', private: true, type: 'module',
    scripts: { build: 'tsc', contract: 'node dist/contract-example.js' },
    dependencies: { '@use-brian/brian-app': '0.1.0', ...(profile === 'native' ? { '@use-brian/shared': '0.0.1', '@use-brian/core': '0.0.1' } : {}) },
    devDependencies: { typescript: '^5.7', '@types/node': '^20' } }
  const files: Record<string,string> = {
    'package.json': JSON.stringify(manifest,null,2)+'\n',
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2022','DOM'],
      strict: true, skipLibCheck: true, outDir: 'dist', rootDir: 'src' }, include: ['src/**/*.ts'] },null,2)+'\n',
    'README.md': `# ${profile} application kit\n\nRuntime qualification is false; generated files do not activate access.\n\nBuild with npm run build; run npm run contract. Local unpublished packages must be supplied by the deployment. No network install is required for package conformance.\n\n${profile === 'native'
      ? 'Deploy src/module.ts through Brian core defineApplicationModules and its canonical service. Supply real query/command schemas, canonical ACL/transaction ports and current authorizeResult checks. Keep defaultState disabled until qualification. Bundle src/browser.ts with a browser bundler and serve its static output; never deploy server module code in that bundle. Standalone sign-in uses app-bound PKCE/consent; Home uses its existing bridge. A static bundle never receives service/native-session secrets.\n'
      : 'Route POST /usebrian/source/{capabilities,authorize,reconcile} to sidecar with raw exact request bytes/target. Configure authenticated transport, issuer/audience/workspace/connector, public trust keys and durable atomic replay storage. Map both Brian actor and assistant to existing source identities and enforce current canonical source ACL, including each recipient/field/action. Null mappings deny. Source capabilities explicitly declare governed/released_snapshot/ephemeral retention support; unsupported modes must deny. Commands use the source transaction and saved idempotency/receipt store, and reconcile before retrying an uncertain effect.\n'}\nNo default authorization, owner fallback, secrets or real accounts are included. Missing deployment callbacks fail unavailable. Use synthetic reserved .example data for local tests. R3 evidence/cache integration, R5b management, R5c reference journeys, R6 qualification, independent source adoption, publication and real setup remain owed.\n`,
  }
  if (profile === 'native') {
    files['src/module.ts'] = nativeModule
    files['src/browser.ts'] = nativeBrowser
    files['src/contract-example.ts'] = `import { createNativeModule } from './module.js'\ntry { createNativeModule(); throw new Error('Expected unavailable') } catch (error) { if (!(error instanceof Error) || error.message !== 'operation_not_available') throw error }\nconsole.log('native unconfigured boundary: unavailable')\n`
    files['index.html'] = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Application kit</title><body><p>Configure the deployed module and bundle src/browser.ts before use.</p></body></html>\n'
    files['brian-app.json'] = JSON.stringify({ manifestVersion: 1, name: 'Example application', entry: 'index.html', scopes: { data: 'none', application: {
      moduleKey: 'example_module', resources: [{ typeKey: 'example_record', actions: ['read','query','command:change'], readFields: ['title'], writeFields: ['title'] }] } } },null,2)+'\n'
  } else {
    files['src/source.ts'] = connectorSource
    files['src/contract-example.ts'] = `import { createConnectorSource } from './source.js'\ntry { await createConnectorSource().sidecar('capabilities', { method: 'POST', target: '/usebrian/source/capabilities', body: new TextEncoder().encode('{}') }, 'unconfigured'); throw new Error('Expected unavailable') } catch (error) { if (!(error instanceof Error) || error.message !== 'source_unavailable') throw error }\nconsole.log('connector unconfigured boundary: unavailable')\n`
  }
  return Object.freeze(files)
}
export function scaffold(profile: ScaffoldProfile, destination: string): void {
  const files = scaffoldFiles(profile)
  if (!destination || destination.includes('\0') || destination.split(/[\\/]/).includes('..')) throw new Error('Unsafe scaffold destination')
  const root = resolve(destination)
  for (let path = root; ; path = dirname(path)) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Unsafe scaffold destination')
    if (path === dirname(path)) break
  }
  if (existsSync(root) && (!lstatSync(root).isDirectory() || readdirSync(root).length)) throw new Error('Scaffold destination must be empty')
  mkdirSync(root, { recursive: true })
  for (const [path, body] of Object.entries(files)) { const file = join(root,path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file,body,{flag:'wx'}) }
}
