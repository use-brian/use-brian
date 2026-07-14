import { lookup } from 'node:dns/promises';
import { imageSize } from 'image-size';
import type { DeckSpec } from '@sidanclaw/shared/decks';
import type { ResolvedDeckImage, ResolvedImages } from './pptx-writer.js';

const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif']);
const EXT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
};
const MAX_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

export interface DeckImageReader {
  /** Reads a workspace file's bytes; throws if missing/forbidden. */
  readBytes(path: string): Promise<Buffer | Uint8Array>;
}

/**
 * Resolves every slide image (public URL or workspace file) to a data URI +
 * intrinsic dimensions. URL fetching runs IN-PROCESS in apps/api, so the
 * SSRF guard is stricter than the standalone repo it was ported from: every
 * hop's hostname is DNS-resolved and rejected if ANY address is private /
 * loopback / link-local / metadata — redirects are followed manually so each
 * hop re-passes the full check. Workspace-file images never touch the network.
 */
export async function resolveDeckImages(spec: DeckSpec, reader: DeckImageReader): Promise<ResolvedImages> {
  const resolved: ResolvedImages = new Map();
  const seen = new Set<string>();
  for (const slide of spec.slides) {
    const source = slide.image;
    if (!source) continue;
    const key = source.url ?? source.path;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    resolved.set(key, source.path ? await readWorkspaceImage(source.path, reader) : await fetchPublicImage(source.url!));
  }
  return resolved;
}

async function readWorkspaceImage(path: string, reader: DeckImageReader): Promise<ResolvedDeckImage> {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await reader.readBytes(path));
  } catch (err) {
    throw new Error(
      `could not read workspace image "${path}" — ${err instanceof Error ? err.message : 'not found'}`,
    );
  }
  if (bytes.length > MAX_BYTES) throw new Error(`image exceeds 10MB: ${path}`);
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const type = EXT_TYPES[ext];
  if (!type) throw new Error(`workspace image "${path}" must be png/jpg/jpeg/gif`);
  return toResolved(bytes, type, path);
}

async function fetchPublicImage(rawUrl: string): Promise<ResolvedDeckImage> {
  let url = await assertSafePublicUrl(rawUrl);
  let res: Response | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'manual' });
    } catch {
      throw new Error(`could not fetch image (network/timeout): ${rawUrl}`);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new Error(`image fetch failed with HTTP ${res.status}: ${rawUrl}`);
      // each redirect hop re-passes the full host + DNS guard
      url = await assertSafePublicUrl(new URL(location, url).href);
      res = undefined;
      continue;
    }
    break;
  }
  if (!res) throw new Error(`too many redirects fetching image: ${rawUrl}`);
  if (!res.ok) throw new Error(`image fetch failed with HTTP ${res.status}: ${rawUrl}`);

  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.has(type)) {
    throw new Error(`unsupported image type "${type || 'unknown'}" (png/jpeg/gif only): ${rawUrl}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`image exceeds 10MB: ${rawUrl}`);
  return toResolved(buf, type, rawUrl);
}

function toResolved(bytes: Buffer, type: string, ref: string): ResolvedDeckImage {
  let dims: { width?: number; height?: number };
  try {
    dims = imageSize(bytes);
  } catch {
    throw new Error(`could not read image dimensions (corrupt file?): ${ref}`);
  }
  if (!dims.width || !dims.height) throw new Error(`could not read image dimensions: ${ref}`);
  return { data: `data:${type};base64,${bytes.toString('base64')}`, width: dims.width, height: dims.height };
}

// ---------------------------------------------------------------------------
// SSRF guard — host rules + DNS resolution
// ---------------------------------------------------------------------------

export async function assertSafePublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid image url: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`image url must be http(s): ${raw}`);
  }
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === 'metadata.google.internal' ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    isPrivateAddress(host)
  ) {
    throw new Error(`image url host not allowed: ${host}`);
  }
  // Hostname (not an IP literal): resolve it and reject if ANY address is private.
  if (!/^[\d.]+$/.test(host) && !host.startsWith('[')) {
    let addresses: { address: string }[];
    try {
      addresses = await lookup(host, { all: true });
    } catch {
      throw new Error(`could not resolve image host: ${host}`);
    }
    for (const { address } of addresses) {
      if (isPrivateAddress(address)) {
        throw new Error(`image url host resolves to a private address: ${host}`);
      }
    }
  }
  return url;
}

export function isPrivateAddress(host: string): boolean {
  const bare = host.replace(/^\[/, '').replace(/\]$/, '');
  const m = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) // CGNAT, includes some cloud metadata ranges
    );
  }
  if (bare.includes(':')) {
    const v6 = bare.toLowerCase();
    if (v6 === '::' || v6 === '::1') return true;
    if (v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb')) return true; // link-local
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // unique-local
    const v4mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4mapped) return isPrivateAddress(v4mapped[1]);
    return false;
  }
  return false;
}
