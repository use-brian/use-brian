/**
 * Handle generation for user discovery.
 *
 * Format: adjective-animal-NNNN (e.g., "fast-turtle-0281").
 * See docs/plans/inter-assistant-communication.md → "Discovery".
 */

const ADJECTIVES = [
  'bold', 'brave', 'bright', 'calm', 'clever', 'cool', 'crisp', 'daring',
  'eager', 'fair', 'fast', 'fierce', 'fond', 'free', 'fresh', 'gentle',
  'glad', 'golden', 'grand', 'happy', 'hardy', 'keen', 'kind', 'lively',
  'lucid', 'merry', 'mild', 'noble', 'perky', 'plush', 'prime', 'proud',
  'pure', 'quick', 'quiet', 'rapid', 'ready', 'rich', 'sharp', 'shiny',
  'sleek', 'smart', 'smooth', 'snowy', 'solar', 'solid', 'spry', 'steady',
  'still', 'stout', 'sunny', 'super', 'sure', 'sweet', 'swift', 'tall',
  'tidy', 'tough', 'true', 'vivid', 'warm', 'whole', 'wild', 'wise',
  'witty', 'young', 'zesty', 'agile', 'amber', 'azure', 'coral', 'cubic',
  'dusty', 'elfin', 'fleet', 'frosty', 'giddy', 'hazy', 'icy', 'ivory',
  'jade', 'jolly', 'jumpy', 'laser', 'lunar', 'maple', 'mossy', 'nifty',
  'oaken', 'olive', 'onyx', 'opal', 'pearl', 'peppy', 'piney', 'plaid',
  'polar', 'rainy', 'rosy', 'royal', 'ruby', 'rusty', 'sage', 'sandy',
  'silky', 'snug', 'sonic', 'spicy', 'steel', 'stone', 'tawny', 'teal',
  'tipsy', 'topaz', 'ultra', 'vapor', 'velvet', 'zen', 'zippy', 'breezy',
  'cedar', 'crispy', 'dewy', 'downy', 'dusky', 'earthy', 'fiery', 'fizzy',
  'flint', 'foggy', 'glow', 'grape', 'gusty', 'hazel', 'honey', 'inky',
  'iron', 'lemon', 'lilac', 'linen', 'lucky', 'magic', 'mint', 'misty',
  'mocha', 'neon', 'nimble', 'nutty', 'ocean', 'pastel', 'peach', 'pixel',
  'plum', 'prism', 'quartz', 'river', 'satin', 'scarlet', 'silver', 'slate',
  'smoke', 'spark', 'sprig', 'starry', 'storm', 'sugar', 'terra', 'thistle',
  'timber', 'torch', 'tulip', 'turbo', 'umbra', 'urban', 'vanilla', 'vernal',
  'vinyl', 'walnut', 'wheat', 'willow', 'woven', 'yarn', 'zephyr', 'zinc',
  'aspen', 'birch', 'chai', 'clover', 'comet', 'dawn', 'drift', 'dusk',
  'echo', 'ember', 'fawn', 'flax', 'flora', 'frost', 'gem', 'ginger',
] as const

const ANIMALS = [
  'ant', 'ape', 'bat', 'bear', 'bee', 'bird', 'boar', 'buck',
  'bull', 'calf', 'cat', 'clam', 'cod', 'colt', 'crab', 'crow',
  'deer', 'dog', 'dove', 'duck', 'eel', 'elk', 'emu', 'ewe',
  'fawn', 'fish', 'fly', 'fox', 'frog', 'goat', 'grub', 'gull',
  'hare', 'hawk', 'hen', 'hog', 'ibis', 'jay', 'koi', 'lark',
  'lion', 'lynx', 'mink', 'mole', 'moth', 'mule', 'newt', 'orc',
  'orca', 'owl', 'ox', 'pike', 'pony', 'puma', 'quail', 'ram',
  'ray', 'robin', 'seal', 'slug', 'snail', 'snake', 'stag', 'swan',
  'toad', 'trout', 'tuna', 'vole', 'wasp', 'wolf', 'wren', 'yak',
  'coral', 'crane', 'drake', 'eagle', 'egret', 'finch', 'gecko',
  'goose', 'grouse', 'heron', 'horse', 'koala', 'lemur', 'llama',
  'macaw', 'moose', 'mouse', 'otter', 'panda', 'perch', 'raven',
  'rhino', 'shark', 'shrew', 'skunk', 'sloth', 'squid', 'stork',
  'swift', 'tiger', 'viper', 'whale', 'zebra', 'bison', 'camel',
  'chimp', 'civet', 'cobra', 'dingo', 'drago', 'falcon', 'ferret',
  'gopher', 'grizzly', 'hippo', 'iguana', 'jackal', 'jaguar', 'kite',
  'liger', 'mantis', 'marlin', 'marten', 'osprey', 'parrot', 'pelican',
  'pigeon', 'python', 'rabbit', 'salmon', 'serval', 'toucan', 'turtle',
  'walrus', 'weasel', 'badger', 'beetle', 'bobcat', 'canary', 'coyote',
  'donkey', 'ermine', 'falcon', 'gerbil', 'gibbon', 'hornet', 'impala',
  'jerboa', 'kitten', 'lizard', 'magpie', 'marmot', 'narwhal', 'ocelot',
  'oriole', 'oyster', 'panther', 'parrot', 'puffin', 'raptor', 'robin',
  'condor', 'cuckoo', 'curlew', 'darter', 'gannet', 'grebe', 'harrier',
  'hoopoe', 'jacana', 'loris', 'merlin', 'minnow', 'mullet', 'numbat',
  'okapi', 'padda', 'plover', 'quokka', 'stoat', 'tapir', 'tern',
] as const

/**
 * Generate a handle in the format "adjective-animal-NNNN".
 * ~200 adjectives × ~200 animals × 10000 = ~400M combinations.
 */
export function generateHandle(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)]
  const num = String(Math.floor(Math.random() * 10000)).padStart(4, '0')
  return `${adj}-${animal}-${num}`
}

/**
 * Validate a handle format: lowercase alphanumeric + hyphens, 3-30 chars.
 */
export function validateHandle(handle: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(handle)
}
