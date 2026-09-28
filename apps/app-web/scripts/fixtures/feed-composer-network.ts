// Only the authenticated transport is replaced. UI, SDKs, SSE and recorder
// controls remain production code; no request can reach an application server.
export * from '../../src/lib/auth-fetch';
const encode = (event: string, data: unknown = {}) => new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
let running: ReadableStreamDefaultController<Uint8Array> | undefined;
const pendingInputs: string[] = [];
export const requests: { url: string; body: Record<string, unknown> }[] = [];
export const getAccessToken = () => null;
export async function authFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input, location.origin);
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
  requests.push({ url: url.pathname, body });
  if (url.pathname.startsWith('/api/doc-files/')) return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><rect width="480" height="320" fill="steelblue"/></svg>', { headers: { 'Content-Type': 'image/svg+xml' } });
  if (url.pathname === '/api/chat/stop') {
    for (const inputId of pendingInputs.splice(0)) running?.enqueue(encode('input_applied', { inputId, messageId: `applied-${inputId}` }));
    running?.enqueue(encode('done')); running?.close(); running = undefined;
    return Response.json({ stopped: true });
  }
  if (url.pathname === '/api/chat' && init?.method === 'POST') {
    if (body.inputId) { pendingInputs.push(body.inputId); return new Response(encode('done')); }
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      running = controller;
      controller.enqueue(encode('research_quota', { used: 1, quota: 10, isPaid: false }));
      controller.enqueue(encode('text_delta', { text: 'Updating the fictional draft.' }));
      init.signal?.addEventListener('abort', () => { if (running === controller) { controller.close(); running = undefined; } }, { once: true });
    } }));
  }
  if (url.pathname.endsWith('/stream')) return new Response(new Uint8Array([...encode('status', { status: 'idle' }), ...encode('done')]));
  if (url.pathname.endsWith('/messages')) return Response.json([]);
  if (url.pathname.endsWith('/pending')) return Response.json({ pending: null, toolConfirmation: null });
  if (url.pathname === '/api/usage') return Response.json({ plan: 'max' });
  if (url.pathname === '/api/goals') return Response.json({ goals: [] });
  if (url.pathname.includes('/skills') || url.pathname.includes('/slash-commands')) return Response.json([]);
  throw new Error(`Unmocked fixture request: ${url.pathname}`);
}
