import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

export class StructuredOcrError extends Error {
  constructor(public readonly code: string) {
    super(`Structured OCR request failed (${code}).`);
    this.name = 'StructuredOcrError';
  }
}
export interface StructuredOcrClient {
  health(): Promise<{ version: '1.1'; busy: boolean }>;
  submit(pdf: Uint8Array, filename: string, idempotencyKey: string): Promise<{ id: string }>;
  status(id: string): Promise<{ status: 'queued' | 'running' | 'completed' | 'failed'; error?: string }>;
  records(id: string): Promise<Uint8Array>;
  image(id: string, page: number): Promise<Uint8Array>;
}

// Private Node transport: no ambient proxy/dispatcher and no redirect handling.
const directFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
  return new Promise<Response>((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: request.method, headers: Object.fromEntries(request.headers), signal: request.signal, agent: false,
    }, response => {
      try {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
        const status = response.statusCode ?? 500;
        const noBody = [204, 205, 304].includes(status);
        if (noBody) response.resume();
        resolve(new Response(noBody ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers }));
      } catch { response.destroy(); reject(new StructuredOcrError('invalid_response')); }
    });
    req.on('error', reject);
    req.end(body);
  });
};
const MiB = 1024 * 1024;
const jobId = z.string().regex(/^[a-f0-9]{32}$/);
const scopeSchema = z.string().regex(/^[a-f0-9]{64}$/);
const capabilities = z.object({ protocol: z.literal('ocr-evidence/1'), version: z.literal('1.1'), busy: z.boolean(), maxPdfBytes: z.literal(15 * MiB), maxPages: z.literal(10) }).strict();
const statusSchema = z.object({ status: z.enum(['queued', 'running', 'completed', 'failed']) }).strict();
const descriptor = z.object({ path: z.string(), sha256: scopeSchema, sizeBytes: z.number().int().positive().safe() }).strict();
function fail(code: string): never { throw new StructuredOcrError(code); }
function parseJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return fail('invalid_response'); }
}
function validId(id: string): string { return jobId.safeParse(id).success ? id : fail('invalid_job_id'); }

export function createStructuredOcrClient(config: { baseUrl: string; token: string; scope?: string; fetchFn?: typeof fetch }): StructuredOcrClient {
  let base: URL;
  try {
    base = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash ||
        base.pathname !== '/mcp' || config.baseUrl !== base.origin + '/mcp' ||
        typeof config.token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(config.token) ||
        (config.scope !== undefined && !scopeSchema.safeParse(config.scope).success)) throw new Error();
  } catch { return fail('invalid_configuration'); }
  const endpoint = base.href;
  const origin = base.origin;
  const token = config.token;
  const scope = config.scope;
  const fetchFn = config.fetchFn ?? directFetch;
  function requireScope() { if (!scope) fail('invalid_scope'); }

  // One deadline covers initialization, upload/tool exchange, and all response bodies.
  async function operation<T>(work: (request: (path: string, limit: number, init?: RequestInit, rpc?: boolean) => Promise<Response>) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
    async function request(path: string, limit: number, init: RequestInit = {}, rpc = false): Promise<Response> {
      if (controller.signal.aborted) return fail('timeout');
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${token}`);
      if (scope) headers.set('X-OCR-Scope', scope);
      // MCP requires advertising both types; this adapter still rejects SSE responses.
      if (rpc) headers.set('Accept', 'application/json, text/event-stream');
      const response = await fetchFn(origin + path, { ...init, headers, signal: controller.signal, redirect: 'manual' });
      const rejectResponse = (code: string): never => { void response.body?.cancel().catch(() => {}); return fail(code); };
      if (controller.signal.aborted) return rejectResponse('timeout');
      if (response.status >= 300 && response.status < 400) return rejectResponse('redirect_rejected');
      if (!response.ok) return rejectResponse(response.status === 401 || response.status === 403 ? 'unauthorized' : response.status === 404 ? 'not_found' : response.status === 409 ? 'conflict' : 'http_error');
      if (rpc && (response.headers.has('mcp-session-id') || (response.status !== 202 && response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json'))) return rejectResponse('invalid_response');
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) return rejectResponse('response_too_large');
      const chunks: Uint8Array[] = [];
      let length = 0;
      const reader = response.body?.getReader();
      if (reader) {
        readers.add(reader);
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > limit || chunks.length >= 65_536) return fail('response_too_large');
            chunks.push(value);
          }
        } finally { readers.delete(reader); void reader.cancel().catch(() => {}); }
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      if (rpc && typeof init.body === 'string' && JSON.parse(init.body).method === 'initialize') {
        const handshake = z.object({ result: z.object({ protocolVersion: z.enum(['2025-03-26', '2025-06-18', '2025-11-25']) }) }).safeParse(parseJson(bytes));
        if (!handshake.success) return fail('invalid_response');
      }
      return new Response([204, 205].includes(response.status) ? null : bytes, { status: response.status, headers: response.headers });
    }
    try {
      return await Promise.race([work(request), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new StructuredOcrError('timeout')); }, 30_000);
      })]);
    } catch (error) { throw error instanceof StructuredOcrError ? error : new StructuredOcrError('transport_error'); }
    finally {
      clearTimeout(timer); controller.abort();
      for (const reader of readers) void reader.cancel().catch(() => {});
    }
  }
  type RequestFn = Parameters<Parameters<typeof operation>[0]>[0];
  async function tool(request: RequestFn, name: string, args: Record<string, unknown>, onCall?: () => void): Promise<unknown> {
    const client = new Client({ name: 'brian-structured-ocr', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      fetch: async (input, init) => {
        if (String(input) !== endpoint) return fail('invalid_response');
        // SDK probes SSE after initialized; this JSON-only protocol has none.
        if (init?.method === 'GET') return new Response(null, { status: 405 });
        if (init?.method !== 'POST') return fail('invalid_response');
        return request('/mcp', 256 * 1024, init, true);
      },
    });
    try {
      await client.connect(transport);
      onCall?.();
      const result = await client.callTool({ name, arguments: args });
      const envelope = z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() }).strict()).length(1), structuredContent: z.record(z.unknown()).optional(), isError: z.boolean().optional() }).strict().safeParse(result);
      if (!envelope.success) return fail('invalid_response');
      const data = parseJson(new TextEncoder().encode(envelope.data.content[0]!.text));
      if (envelope.data.structuredContent !== undefined && !sameJson(data, envelope.data.structuredContent)) return fail('invalid_response');
      if (envelope.data.isError) {
        const error = z.object({ error: z.object({ code: z.enum(['busy', 'uncertain_submission', 'unauthorized', 'not_found', 'invalid_request', 'conflict']) }).strict() }).strict().safeParse(data);
        return fail(error.success ? error.data.error.code : 'tool_error');
      }
      return data;
    } finally { await client.close(); }
  }
  async function artifact(id: string, page?: number): Promise<Uint8Array> {
    requireScope(); validId(id);
    if (page !== undefined && (!Number.isInteger(page) || page < 1 || page > 10)) return fail('invalid_page');
    return operation(async request => {
      const path = `/transfer/${id}/${page === undefined ? 'records' : `page-${page}.png`}`;
      const limit = (page === undefined ? 16 : 20) * MiB;
      const parsed = descriptor.safeParse(await tool(request, page === undefined ? 'ocr_records' : 'ocr_source_page', page === undefined ? { jobId: id } : { jobId: id, page }));
      if (!parsed.success || parsed.data.path !== path || parsed.data.sizeBytes > limit) return fail('invalid_response');
      const bytes = new Uint8Array(await (await request(path, limit)).arrayBuffer());
      if (bytes.length !== parsed.data.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== parsed.data.sha256) return fail('invalid_response');
      if (page === undefined) parseJson(bytes);
      else if (![137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)) return fail('invalid_response');
      return bytes;
    });
  }
  return {
    health: () => operation(async request => {
      const parsed = capabilities.safeParse(await tool(request, 'ocr_capabilities', {}));
      if (!parsed.success) return fail('invalid_response');
      return { version: '1.1', busy: parsed.data.busy };
    }),
    async submit(pdf, filename, idempotencyKey) {
      requireScope(); validId(idempotencyKey);
      if (!(pdf instanceof Uint8Array) || pdf.length > 15 * MiB || new TextDecoder().decode(pdf.subarray(0, 5)) !== '%PDF-' ||
          typeof filename !== 'string' || !filename || filename.length > 200 || /[\x00-\x1f\x7f/\\]/.test(filename)) return fail('invalid_pdf');
      // Only the outer policy-authorized start may invoke this method. Staging never starts OCR.
      let started = false;
      try {
        return await operation(async request => {
          const receipt = z.object({ uploadId: z.literal(idempotencyKey) }).strict().safeParse(parseJson(new Uint8Array(await (await request(`/transfer/${idempotencyKey}`, 256 * 1024, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: new Uint8Array(pdf) })).arrayBuffer())));
          if (!receipt.success) return fail('invalid_response');
          const result = z.object({ id: z.literal(idempotencyKey) }).strict().safeParse(await tool(request, 'ocr_start', { uploadId: idempotencyKey }, () => { started = true; }));
          if (!result.success) return fail('invalid_response');
          return result.data;
        });
      } catch (error) {
        if (started && !(error instanceof StructuredOcrError && ['busy', 'unauthorized'].includes(error.code))) return fail('uncertain_submission');
        throw error;
      }
    },
    async status(id) {
      requireScope(); validId(id);
      return operation(async request => {
        const parsed = statusSchema.safeParse(await tool(request, 'ocr_status', { jobId: id }));
        if (!parsed.success) return fail('invalid_response');
        return parsed.data.status === 'failed' ? { status: 'failed', error: 'OCR extraction failed.' } : parsed.data;
      });
    },
    records: id => artifact(id), image: (id, page) => artifact(id, page),
  };
}
// Compare JSON structurally, not by server object-key order.
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a); const right = Object.keys(b);
  return left.length === right.length && left.every(key => Object.hasOwn(b, key) && sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
