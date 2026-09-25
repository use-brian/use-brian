import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, it } from 'vitest';
import { createStructuredOcrClient } from '../client.js';

const python = process.env.OCR_CONNECTOR_PYTHON;
const project = process.env.OCR_CONNECTOR_PROJECT_ROOT;

// Opt-in cross-project test: no Python dependency for ordinary Brian tests.
it.skipIf(!python || !project)('[COMP:api/structured-documents] official SDK and bridge interoperate with Python sidecar', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocr-mcp-interop-'));
  const dataDir = join(root, 'data');
  const configPath = join(root, 'config.json');
  const token = 'fictional-connector-token-'.repeat(2);
  const upstreamToken = 'fictional-upstream-token';
  const scope = 'b'.repeat(64), id = 'a'.repeat(32), remote = 'c'.repeat(32);
  const pdf = Buffer.from('%PDF-1.7\nfictional interop fixture\n%%EOF');
  const sourceHash = createHash('sha256').update(pdf).digest('hex');
  const records = Buffer.from(JSON.stringify({ schema_version: '1.1', source: { sha256: sourceHash }, pages: [{ page: 1, text: 'fictional' }] }));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const upstreamCalls: string[] = [];
  let submitted: Buffer | undefined;
  const upstream = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${upstreamToken}`) { res.writeHead(401).end(); return; }
    upstreamCalls.push(`${req.method} ${req.url}`);
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/health') res.end(JSON.stringify({ busy: false, records_export_version: '1.1' }));
    else if (req.url === '/api/jobs' && req.method === 'POST') {
      submitted = Buffer.concat(chunks); res.end(JSON.stringify({ id: remote }));
    } else if (req.url === `/api/jobs/${remote}`) res.end(JSON.stringify({ status: 'completed', result: { private_upstream_field: 'never in MCP' } }));
    else if (req.url === `/api/jobs/${remote}/records?version=1.1`) res.end(records);
    else if (req.url === `/api/jobs/${remote}/files/page-1.png`) { res.setHeader('Content-Type', 'image/png'); res.end(png); }
    else res.writeHead(404).end();
  });
  let child: ChildProcess | undefined;
  const discovery = new Client({ name: 'interop-discovery', version: '1' });
  try {
    await mkdir(dataDir, { mode: 0o700 });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as { port: number }).port;
    await writeFile(configPath, JSON.stringify({ credentials: [{ owner: 'fixture-owner', token }], upstream_url: `http://127.0.0.1:${upstreamPort}`, upstream_token: upstreamToken }), { mode: 0o600 });
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    // Let Python bind port zero itself, avoiding a reserve/release port race.
    child = spawn(python!, ['-u', '-c', `
import os, socket, sys
import uvicorn
from connector_server import create_app, load_config
os.umask(0o077)
app = create_app(load_config(sys.argv[1]), sys.argv[2])
sock = socket.socket()
sock.bind(('127.0.0.1', 0))
sock.listen(128)
print(sock.getsockname()[1], flush=True)
uvicorn.Server(uvicorn.Config(app, log_level='critical', access_log=False)).run(sockets=[sock])
`, configPath, dataDir], { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
    // Consume stderr without retaining potentially sensitive server diagnostics.
    child.stderr!.resume();
    const port = await new Promise<number>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => finish(new Error('Sidecar startup timed out')), 10_000);
      const finish = (error?: Error, value?: number) => {
        clearTimeout(timer); child!.stdout!.off('data', onData); child!.off('error', onError); child!.off('exit', onExit);
        if (error) reject(error); else resolve(value!);
      };
      const onError = () => finish(new Error('Sidecar startup failed'));
      const onExit = () => finish(new Error('Sidecar exited during startup'));
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        if (/^\d+\n/.test(output)) finish(undefined, Number(output.trim()));
        else if (output.length > 1024) finish(new Error('Invalid sidecar startup response'));
      };
      child!.stdout!.on('data', onData); child!.once('error', onError); child!.once('exit', onExit);
    });
    const baseUrl = `http://127.0.0.1:${port}/mcp`;
    await discovery.connect(new StreamableHTTPClientTransport(new URL(baseUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const tools = await discovery.listTools();
    expect(tools.tools.map(t => t.name).sort()).toEqual(['ocr_capabilities', 'ocr_records', 'ocr_source_page', 'ocr_start', 'ocr_status']);
    expect(upstreamCalls).toEqual([]);
    const client = createStructuredOcrClient({ baseUrl, token, scope });
    await expect(client.health()).resolves.toEqual({ version: '1.1', busy: false });
    expect(upstreamCalls).toEqual(['GET /api/health']);
    await expect(client.submit(pdf, 'fictional.pdf', id)).resolves.toEqual({ id });
    expect(submitted?.includes(pdf)).toBe(true);
    expect(createHash('sha256').update(await readFile(join(dataDir, `${id}.pdf`))).digest('hex')).toBe(sourceHash);
    await expect(client.status(id)).resolves.toEqual({ status: 'completed' });
    expect(Buffer.from(await client.records(id))).toEqual(records);
    expect(Buffer.from(await client.image(id, 1))).toEqual(png);
    // Immutable cache and idempotent staging/start replay do not resubmit upstream.
    await expect(client.submit(pdf, 'fictional.pdf', id)).resolves.toEqual({ id });
    expect(Buffer.from(await client.records(id))).toEqual(records);
    expect(upstreamCalls.filter(c => c === 'POST /api/jobs')).toHaveLength(1);
    expect(upstreamCalls.filter(c => c.endsWith('/records?version=1.1'))).toHaveLength(1);
    for (const name of ['ocr_status', 'ocr_records', 'ocr_source_page']) {
      const denied = await discovery.callTool({ name, arguments: { jobId: id, ...(name === 'ocr_source_page' ? { page: 1 } : {}) } });
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toBeUndefined();
      expect(JSON.stringify(denied)).not.toContain('fictional');
    }
    const unscopedTransfer = await fetch(`http://127.0.0.1:${port}/transfer/${id}/records`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' });
    expect(unscopedTransfer.ok).toBe(false);
    await unscopedTransfer.body?.cancel();
  } finally {
    await discovery.close().catch(() => {});
    if (child && child.exitCode === null && child.signalCode === null) {
      const process = child;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => process.kill('SIGKILL'), 3000);
        process.once('exit', () => { clearTimeout(timer); resolve(); });
        process.kill('SIGTERM');
      });
    }
    upstream.closeAllConnections();
    if (upstream.listening) await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
