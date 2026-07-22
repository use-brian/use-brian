// Microsoft Teams app package (manifest.json + color/outline icons) that
// Studio → Channels offers as a one-click ready-to-upload zip download.
// Entries are STORED (no compression) — the PNGs are already compressed and
// the manifest is tiny — which keeps the builder dependency-free.
// [COMP:app-web/teams-app-package]

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Fixed DOS timestamp (2020-01-01 00:00) so identical inputs produce a
// byte-identical package.
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

export function buildStoredZip(entries: ZipEntry[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, entry.data.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, entry.data.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    parts.push(local, entry.data);
    centrals.push(central);
    offset += local.length + entry.data.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + eocd.length);
  let pos = 0;
  for (const part of [...parts, ...centrals, eocd]) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

export function buildTeamsManifest(appId: string): Record<string, unknown> {
  const botId = appId.trim() || "<AZURE_BOT_APP_ID>";
  return {
    $schema:
      "https://developer.microsoft.com/en-us/json-schemas/teams/v1.16/MicrosoftTeams.schema.json",
    manifestVersion: "1.16",
    id: botId,
    packageName: "ai.usebrian.assistant",
    name: { short: "Use Brian", full: "Use Brian AI assistant" },
    description: {
      short: "AI assistant powered by Use Brian",
      full: "AI assistant powered by Use Brian",
    },
    developer: {
      name: "Use Brian",
      websiteUrl: "https://usebrian.ai",
      privacyUrl: "https://usebrian.ai/privacy",
      termsOfUseUrl: "https://usebrian.ai/terms",
    },
    icons: { color: "color.png", outline: "outline.png" },
    accentColor: "#1e293b",
    bots: [
      {
        botId,
        scopes: ["personal", "team", "groupChat"],
        supportsFiles: false,
        isNotificationOnly: false,
      },
    ],
    permissions: ["identity", "messageTeamMembers"],
    validDomains: [],
  };
}

export function buildTeamsAppPackage(
  appId: string,
  colorPng: Uint8Array,
  outlinePng: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const manifest = new TextEncoder().encode(
    JSON.stringify(buildTeamsManifest(appId), null, 2),
  );
  return buildStoredZip([
    { name: "manifest.json", data: manifest },
    { name: "color.png", data: colorPng },
    { name: "outline.png", data: outlinePng },
  ]);
}
