import type { DrawingLibraryItem } from './drawing-library.js';

// V1 pixel data from usebrian.ai/brand/interns, platform apps/web/src/lib/brand-mascot.ts.
// Rows retain the empty eighth column. Names are the source download stems.
const base = ['00000000', '00111000', '01111100', '11212110', '11111110', '01111100', '00101000', '00000000'];
const accessories = {
  hardhat: { rows: ['00333000', '03333300', '01111100'], color: '#fbbf24' },
  gradcap: { rows: ['03333300', '00030000', '01111100'], color: '#f1f5f9' },
  halo: { rows: ['00777000'], color: '#fbbf24' },
  headphones: { rows: ['00000000', '00333000', '03111300', '31212130'], color: '#a78bfa' },
  sunglasses: { rows: ['00000000', '00111000', '01111100', '13333310'], color: '#1e293b' },
  scarf: { rows: ['00000000', '00111000', '01111100', '11212110', '44444440', '04111400', '04101400'], color: '#ef4444' },
  hoodie: { rows: ['00000000', '03333300', '33111330', '31212130', '31111130'], color: '#475569' },
  sleepy: { rows: ['00000000', '00111000', '01111100', '11919110'], color: '#00e5ff' },
  'speech-hi': { rows: ['05555500', '05555500', '00151000', '01111100', '11212110', '11111110', '01111100', '00101000'], color: '#f1f5f9' },
  beanie: { rows: ['00333000', '03333300', '01111100'], color: '#f472b6' },
  'party-hat': { rows: ['00070000', '00333000', '03333300'], color: '#a78bfa' },
  'cat-ears': { rows: ['03000300', '03111300'], color: '#f472b6' },
  sprout: { rows: ['00333000', '00131000'], color: '#34d399' },
  'wizard-hat': { rows: ['00030000', '00333000', '03333300'], color: '#a78bfa' },
  wave: { rows: ['00000000', '10111010', '11111110'], color: '#00e5ff' },
};
type Accessory = keyof typeof accessories;
const disciplines = {
  communications: '#cbd5e1', business: '#d4a574', 'fine-arts': '#f1f5f9', journalism: '#dc2626',
  theatre: '#ec4899', economics: '#b87333', physics: '#eab308', 'computer-science': '#14b8a6',
  engineering: '#f97316', mathematics: '#fde047', philosophy: '#1e3a8a', 'environmental-science': '#22c55e',
  'public-admin': '#0ea5e9', nursing: '#fdba74', psychology: '#fb7185', 'liberal-arts': '#e2e8f0',
  education: '#7dd3fc', hospitality: '#c4a582', 'social-work': '#bef264', 'media-studies': '#a78bfa',
};
type Discipline = keyof typeof disciplines;
const roles: Record<string, [Discipline, Accessory?][]> = {
  marketing: [['communications'], ['business'], ['fine-arts', 'sunglasses'], ['journalism'], ['theatre'], ['economics', 'halo']],
  productResearch: [['physics', 'gradcap'], ['computer-science', 'headphones'], ['engineering', 'hardhat'], ['mathematics', 'gradcap'], ['philosophy'], ['environmental-science']],
  customerService: [['engineering', 'hardhat'], ['communications', 'headphones'], ['public-admin'], ['nursing'], ['psychology', 'sleepy'], ['social-work', 'scarf']],
  community: [['liberal-arts', 'hoodie'], ['education'], ['hospitality', 'scarf'], ['social-work', 'hoodie'], ['media-studies', 'speech-hi']],
};

// Old versions remain available solely to recognize unedited, persisted seeds.
export function defaultDrawingLibrary(version: 1 | 2 | 3 | 4 = 4): DrawingLibraryItem[] {
  const assets = new Map<string, { accessory?: Accessory; discipline?: Discipline; borders: boolean; roles: string[] }>();
  if (version < 4) assets.set('use-brian', { borders: false, roles: [] });
  assets.set('use-brian-bordered', { borders: true, roles: [] });
  for (const accessory of Object.keys(accessories) as Accessory[]) {
    assets.set(`brian-intern-${accessory}`, { accessory, borders: true, roles: [] });
  }
  for (const [role, candidates] of Object.entries(roles)) {
    for (const [discipline, accessory] of candidates) {
      const name = ['brian-intern', discipline, accessory].filter(Boolean).join('-');
      if (!assets.has(name)) assets.set(name, { discipline, accessory, borders: true, roles: [] });
      assets.get(name)!.roles.push(role);
    }
  }
  return [...assets].map(([name, asset]) => {
    const id = `brian-default-v1-${name}`;
    const elements: Record<string, unknown>[] = [];
    const art = asset.accessory ? accessories[asset.accessory] : undefined;
    const rect = (x: number, y: number, width: number, height: number, color: string) => {
      elements.push({ id: `${id}-${elements.length}`, type: 'rectangle',
        x: x * 160 / 512, y: y * 160 / 512, width: width * 160 / 512, height: height * 160 / 512,
        angle: 0, strokeColor: 'transparent', backgroundColor: color, fillStyle: 'solid',
        strokeWidth: 0, strokeStyle: 'solid', roughness: 0, opacity: 100, roundness: null,
        seed: elements.length + 1, version: 1, versionNonce: 1, updated: 1, isDeleted: false,
        groupIds: [id], frameId: null, boundElements: null, link: null, locked: false,
        ...(elements.length === 0 ? { customData: { source: 'https://usebrian.ai/brand/interns', name, ...asset } } : {}) });
    };
    const cell = (x: number, y: number, color: string) => {
      if (asset.borders) {
        rect(x, y, 64, 64, '#121e33');
        // Marketing uses a 1px inset at output size, not at the 512px source size.
        const inset = version === 1 ? 1 : 512 / 160;
        rect(x + inset, y + inset, 64 - inset * 2, 64 - inset * 2, color);
      } else rect(x, y, 64, 64, color);
    };
    rect(0, 0, 512, 512, '#0a1628');
    if (!asset.borders && version === 3) {
      // Legacy V3 silhouette, retained only for exact persisted-seed recognition.
      rect(32, 192, 448, 384, '#00e5ff');
      Object.assign(elements[1], { type: 'line', startArrowhead: null, endArrowhead: null,
        points: [[0, 0], [20, 0], [20, -20], [40, -20], [40, -40],
          [100, -40], [100, -20], [120, -20], [120, 0], [140, 0],
          [140, 40], [120, 40], [120, 60], [100, 60], [100, 80],
          [80, 80], [80, 60], [60, 60], [60, 80], [40, 80],
          [40, 60], [20, 60], [20, 40], [0, 40], [0, 0]] });
    }
    base.forEach((row, y) => {
      [...(art?.rows[y] ?? row)].forEach((value, x) => {
        if (value === '0') return;
        const x0 = 32 + x * 64, y0 = y * 64;
        if (asset.borders || version < 3) cell(x0, y0, ['1', '2', '9'].includes(value) ? '#00e5ff' : value === '7' ? '#fbbf24' : art!.color);
        if (value === '2') rect(x0 + 18, y0 + 18, 29, 29, '#0a1628');
        if (value === '9') rect(x0 + 13, y0 + 26, 38, 12, '#0a1628');
      });
    });
    if (asset.discipline) cell(224, asset.accessory === 'speech-hi' ? 320 : 256, disciplines[asset.discipline]);
    return { id, name, status: 'published', created: 1, elements };
  }) as unknown as DrawingLibraryItem[];
}
