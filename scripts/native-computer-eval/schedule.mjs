import { createHash } from 'node:crypto';

// Seeded xorshift32, Fisher-Yates fixture/trial blocks, then rotated lane
// permutations. Across each six blocks every lane occupies every position twice.
export function schedule(manifest, trials, seed) {
  if (!Number.isInteger(trials) || trials < 1 || trials > 100 || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Invalid schedule');
  let state = seed || 0x9e3779b9;
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = next() % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const orders = shuffle([[0, 1, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0], [0, 2, 1], [1, 0, 2]]);
  // Preserve train -> calibration -> held-out chronology; randomize within splits.
  return ['train', 'calibration', 'held-out'].flatMap(split => {
    const blocks = shuffle(manifest.fixtures.filter(f => f.split === split).flatMap(f => Array.from({ length: trials }, (_, i) => ({ fixture: f.id, trial: i + 1 }))));
    return blocks.flatMap((b, i) => orders[i % 6].map(lane => ({ ...b, lane: manifest.lanes[lane] })));
  });
}
export const scheduleDigest = entries => createHash('sha256').update(JSON.stringify(entries)).digest('hex');
