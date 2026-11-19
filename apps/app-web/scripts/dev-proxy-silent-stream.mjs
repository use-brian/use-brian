// [COMP:app-web/dev-api-proxy] Opt-in real `next dev` regression for the
// development `/api` rewrite proxy idle timeout.
//
// Starts a stub upstream that answers `POST /api/chat` like the chat route
// (SSE headers, one `session` frame) and then stays silent for `--silence-ms`
// (default 60000) before sending `done`. A disposable Next fixture loads
// app-web's real `next.config.ts` and serves its `rewrites` and `experimental`
// (the proxy timeout) through a real `next dev`. The stream must survive the
// silence and end cleanly with the `done` frame. Synthetic data only, no
// application credentials, no database, temporary output removed afterwards.
//
//   node apps/app-web/scripts/dev-proxy-silent-stream.mjs [--silence-ms=60000] [--webpack]
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, request } from 'node:http';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nextRoot = dirname(require.resolve('next/package.json'));
const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.split('=')[1];
const silenceMs = Number(arg('silence-ms') ?? 60000);
const bundler = process.argv.includes('--webpack') ? '--webpack' : '--turbopack';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function freePort() {
  const server = createNetServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

async function put(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

const upstreamEvents = [];
const upstream = createHttpServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/chat') {
    const openedAt = Date.now();
    req.resume();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('event: session\ndata: {"sessionId":"silent-probe"}\n\n');
    const timer = setTimeout(() => {
      res.write('event: done\ndata: {}\n\n');
      res.end();
      upstreamEvents.push({ event: 'upstream_done', atMs: Date.now() - openedAt });
    }, silenceMs);
    res.on('close', () => {
      if (!res.writableEnded) {
        clearTimeout(timer);
        upstreamEvents.push({ event: 'upstream_client_closed_early', atMs: Date.now() - openedAt });
      }
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"stub":true}');
});

const temporary = await mkdtemp(join(tmpdir(), 'brian-dev-proxy-'));
let child = null;
let log = '';
let result;
try {
  const upstreamPort = await freePort();
  await new Promise((done) => upstream.listen(upstreamPort, '127.0.0.1', done));
  const fixture = join(temporary, 'fixture');
  await mkdir(fixture, { recursive: true });
  await symlink(join(app, 'node_modules'), join(fixture, 'node_modules'), 'junction');
  await put(join(fixture, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  // Only the proxy-relevant parts of the real config: the development `/api`
  // rewrite and `experimental` (proxyTimeout). Node strips the TypeScript.
  await put(join(fixture, 'next.config.mjs'), [
    `import appConfig from ${JSON.stringify(pathToFileURL(join(app, 'next.config.ts')).href)};`,
    'export default { devIndicators: false, turbopack: { root: "/" }, experimental: appConfig.experimental, rewrites: appConfig.rewrites };',
    '',
  ].join('\n'));
  await put(join(fixture, 'app/layout.js'), 'export default function Layout({ children }) { return <html><body>{children}</body></html> }\n');
  await put(join(fixture, 'app/page.js'), 'export default function Page() { return "fixture" }\n');

  const port = await freePort();
  child = spawn(process.execPath, [join(nextRoot, 'dist/bin/next'), 'dev', bundler, '--port', String(port), '--hostname', '127.0.0.1'], {
    cwd: fixture,
    detached: true,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NEXT_TELEMETRY_DISABLED: '1',
      API_URL: `http://127.0.0.1:${upstreamPort}`,
      DATABASE_URL: 'postgres://127.0.0.1:1/unreachable',
      DATABASE_URL_APP: 'postgres://127.0.0.1:1/unreachable',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (data) => { log += data; });
  child.stderr.on('data', (data) => { log += data; });

  // Ready when a request through the rewrite reaches the stub.
  const deadline = Date.now() + 120000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`next dev exited early\n${log}`);
    if (Date.now() > deadline) throw new Error(`next dev did not proxy /api in 120 s\n${log}`);
    const probe = await fetch(`http://127.0.0.1:${port}/api/probe`, { signal: AbortSignal.timeout(10000) }).catch(() => null);
    if (probe && (await probe.text()).includes('"stub":true')) break;
    await sleep(500);
  }

  result = await new Promise((done) => {
    const startedAt = Date.now();
    const frames = [];
    let buffer = '';
    let settled = false;
    const finish = (outcome, detail = {}) => {
      if (settled) return;
      settled = true;
      done({ outcome, elapsedMs: Date.now() - startedAt, frames, ...detail });
    };
    const req = request(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1] ?? (block.startsWith(':') ? 'comment' : 'unknown');
          frames.push({ event, atMs: Date.now() - startedAt });
        }
      });
      res.on('end', () => finish('ended', { status: res.statusCode }));
      res.on('aborted', () => finish('aborted', { status: res.statusCode }));
      res.on('error', (error) => finish('error', { status: res.statusCode, error: error.code ?? error.message }));
    });
    req.on('error', (error) => finish('request_error', { error: error.code ?? error.message }));
    req.end('{"message":"silent upstream probe"}');
  });
} finally {
  if (child && child.exitCode === null) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    await Promise.race([new Promise((done) => child.once('exit', done)), sleep(10000)]);
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  await new Promise((done) => upstream.close(done));
  upstream.closeAllConnections?.();
  await rm(temporary, { recursive: true, force: true });
}

const doneFrame = result?.frames.find((frame) => frame.event === 'done');
const pass = result?.outcome === 'ended' && result.status === 200
  && Boolean(doneFrame) && doneFrame.atMs >= silenceMs
  && !upstreamEvents.some((event) => event.event === 'upstream_client_closed_early');
const proxyErrors = log.split('\n').filter((line) => /Failed to proxy|ECONNRESET|socket hang up/.test(line)).slice(0, 5);
console.log(JSON.stringify({ pass, silenceMs, bundler, next: require('next/package.json').version, result, upstreamEvents, proxyErrors }, null, 2));
process.exit(pass ? 0 : 1);
