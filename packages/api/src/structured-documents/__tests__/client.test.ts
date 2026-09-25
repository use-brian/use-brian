import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStructuredOcrClient } from '../client.js';
const id = 'a'.repeat(32), scope = 'b'.repeat(64);
const pdf = new TextEncoder().encode('%PDF-fictional');
const records = new TextEncoder().encode('{"fixture":true}');
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const config = { baseUrl: 'http://127.0.0.1:8765/mcp', token: 'fictional-token', scope };
type Call = { url: string; init?: RequestInit; body: any };
function fixture(override?: (call: Call) => Response | undefined) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.method === 'POST' ? JSON.parse(String(init.body)) : undefined;
    const call = { url, init, body }; calls.push(call);
    if (body && new Headers(init?.headers).get('accept') !== 'application/json, text/event-stream') {
      return new Response(null, { status: 406 });
    }
    const custom = override?.(call); if (custom) return custom;
    if (init?.method === 'PUT') return json({ uploadId: id });
    if (!body) return new Response(url.endsWith('.png') ? png : records);
    if (body.method === 'initialize') return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0' } } });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let data: unknown;
    switch (body.params.name) {
      case 'ocr_capabilities': data = { protocol: 'ocr-evidence/1', version: '1.1', busy: false, maxPdfBytes: 15728640, maxPages: 10 }; break;
      case 'ocr_start': data = { id }; break;
      case 'ocr_status': data = { status: 'completed' }; break;
      default: {
        const image = body.params.name === 'ocr_source_page'; const bytes = image ? png : records;
        data = { path: `/transfer/${id}/${image ? 'page-1.png' : 'records'}`, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length };
      }
    }
    return toolReply(body.id, data);
  };
  return { calls, fetchFn, client: createStructuredOcrClient({ ...config, fetchFn }) };
}
function toolReply(rpcId: number, data: unknown, isError = false) {
  return json({ jsonrpc: '2.0', id: rpcId, result: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError } });
}
afterEach(() => vi.useRealTimers());
describe('[COMP:api/structured-documents] MCP OCR client', () => {
  it.each(['https://host', 'ftp://host/mcp', 'https://u:p@host/mcp', 'https://host/mcp?q=x', 'https://host/mcp#x', 'https://host/other'])('rejects endpoint %s', baseUrl => {
    expect(() => createStructuredOcrClient({ ...config, baseUrl })).toThrow('invalid_configuration');
  });
  it('uses real SDK initialize and exact scoped tools/data plane, without early egress', async () => {
    const { client, calls } = fixture(); expect(calls).toHaveLength(0);
    await expect(client.health()).resolves.toEqual({ version: '1.1', busy: false });
    expect(calls.some(c => c.init?.method === 'PUT')).toBe(false);
    await expect(client.submit(pdf, 'test.pdf', id)).resolves.toEqual({ id });
    await expect(client.status(id)).resolves.toEqual({ status: 'completed' });
    await expect(client.records(id)).resolves.toEqual(records);
    await expect(client.image(id, 1)).resolves.toEqual(png);
    expect(calls.filter(c => c.body?.method === 'initialize')).toHaveLength(5);
    expect(calls.filter(c => c.body?.method === 'tools/call').map(c => c.body.params)).toEqual([
      { name: 'ocr_capabilities', arguments: {} }, { name: 'ocr_start', arguments: { uploadId: id } },
      { name: 'ocr_status', arguments: { jobId: id } }, { name: 'ocr_records', arguments: { jobId: id } },
      { name: 'ocr_source_page', arguments: { jobId: id, page: 1 } },
    ]);
    const upload = calls.find(c => c.init?.method === 'PUT')!;
    expect(upload.url).toBe(`http://127.0.0.1:8765/transfer/${id}`);
    expect(upload.init?.body).toEqual(pdf);
    expect(calls.indexOf(upload)).toBeLessThan(calls.findIndex(c => c.body?.params?.name === 'ocr_start'));
    for (const c of calls) {
      const headers = new Headers(c.init?.headers);
      expect(headers.get('authorization')).toBe('Bearer fictional-token');
      expect(headers.get('x-ocr-scope')).toBe(scope);
      if (c.body) expect(headers.get('accept')).toBe('application/json, text/event-stream');
      expect(c.init?.redirect).toBe('manual');
    }
  });
  it('allows unscoped health only and validates local input before network', async () => {
    const f = fixture(); const client = createStructuredOcrClient({ ...config, scope: undefined, fetchFn: f.fetchFn });
    await client.health();
    await expect(client.status(id)).rejects.toMatchObject({ code: 'invalid_scope' });
    const count = f.calls.length;
    await expect(f.client.submit(pdf, 'a.pdf', 'bad')).rejects.toMatchObject({ code: 'invalid_job_id' });
    await expect(f.client.submit(new Uint8Array(), 'a.pdf', id)).rejects.toMatchObject({ code: 'invalid_pdf' });
    await expect(f.client.image(id, 11)).rejects.toMatchObject({ code: 'invalid_page' });
    await expect(f.client.records('../x')).rejects.toMatchObject({ code: 'invalid_job_id' });
    expect(f.calls).toHaveLength(count);
  });
  it.each(['busy', 'uncertain_submission'])('preserves safe %s without retry', async code => {
    const f = fixture(c => c.body?.params?.name === 'ocr_start' ? toolReply(c.body.id, { error: { code } }, true) : undefined);
    await expect(f.client.submit(pdf, 'x.pdf', id)).rejects.toMatchObject({ code });
    expect(f.calls.filter(c => c.body?.params?.name === 'ocr_start')).toHaveLength(1);
  });
  it('classifies lost start as uncertain but staging conflict as safe', async () => {
    const f = fixture(c => c.body?.params?.name === 'ocr_start' ? new Response('secret', { status: 500 }) : undefined);
    await expect(f.client.submit(pdf, 'x.pdf', id)).rejects.toMatchObject({ code: 'uncertain_submission' });
    const staging = fixture(c => c.init?.method === 'PUT' ? new Response(null, { status: 409 }) : undefined);
    await expect(staging.client.submit(pdf, 'x.pdf', id)).rejects.toMatchObject({ code: 'conflict' });
    expect(staging.calls).toHaveLength(1);
  });
  it.each([
    { path: 'https://attacker.invalid/records' }, { path: `/transfer/${'c'.repeat(32)}/records` },
    { sizeBytes: records.length + 1 }, { sizeBytes: 16 * 1024 * 1024 + 1 }, { sha256: '0'.repeat(64) }, { extra: 'secret' },
  ])('rejects invalid descriptors or bytes %j', async patch => {
    const f = fixture(c => c.body?.params?.name === 'ocr_records' ? toolReply(c.body.id, { path: `/transfer/${id}/records`, sizeBytes: records.length, sha256: createHash('sha256').update(records).digest('hex'), ...patch }) : undefined);
    await expect(f.client.records(id)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(f.calls.every(c => c.url.startsWith('http://127.0.0.1:8765/'))).toBe(true);
  });
  it('rejects extra fields and inconsistent structured content', async () => {
    const f = fixture(c => c.body?.params?.name === 'ocr_status' ? toolReply(c.body.id, { status: 'failed', error: 'secret' }) : undefined);
    await expect(f.client.status(id)).rejects.toMatchObject({ code: 'invalid_response' });
    const g = fixture(c => c.body?.params?.name === 'ocr_status' ? json({ jsonrpc: '2.0', id: c.body.id, result: { content: [{ type: 'text', text: '{"status":"completed"}' }], structuredContent: { status: 'failed' } } }) : undefined);
    await expect(g.client.status(id)).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it.each(['redirect', 'SSE', 'declared', 'streamed'])('rejects %s RPC response', async kind => {
    const f = fixture(() => kind === 'redirect' ? new Response(null, { status: 302 }) : kind === 'SSE' ? new Response('data: secret', { headers: { 'content-type': 'text/event-stream' } }) : new Response(kind === 'streamed' ? new Uint8Array(256 * 1024 + 1) : 'x', { headers: { 'content-type': 'application/json', ...(kind === 'declared' ? { 'content-length': '9999999' } : {}) } }));
    await expect(f.client.health()).rejects.toMatchObject({ code: kind === 'redirect' ? 'redirect_rejected' : kind === 'SSE' ? 'invalid_response' : 'response_too_large' });
  });
  it('bounds ignored abort and stalled SDK response body to 30 seconds', async () => {
    vi.useFakeTimers();
    for (const fetchFn of [async () => new Promise<Response>(() => {}), async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } })]) {
      const result = createStructuredOcrClient({ ...config, fetchFn }).health();
      const assertion = expect(result).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(30_000); await assertion;
    }
  });
  it('interoperates over real direct localhost HTTP with SDK and no SSE network probe', async () => {
    const f = fixture();
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const response = await f.fetchFn(`${config.baseUrl}`, { method: req.method, headers: req.headers as Record<string, string>, body: Buffer.concat(chunks).toString() });
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as { port: number };
      await expect(createStructuredOcrClient({ ...config, baseUrl: `http://127.0.0.1:${address.port}/mcp` }).health()).resolves.toEqual({ version: '1.1', busy: false });
      expect(f.calls.map(c => c.init?.method)).toEqual(['POST', 'POST', 'POST']);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
