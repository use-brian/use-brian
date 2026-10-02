// Generic size/accessor/prototype guard only; ALL event fields/enums/refinements
// are validated by the actual core schema, never a second copied validator.
export function boundedMetadataCopy(input) {
  let bytes = 0, nodes = 0;
  function copy(x, depth) {
    if (++nodes > 256 || depth > 8) throw new Error();
    if (x === undefined || x === null || typeof x === 'boolean' || typeof x === 'number') return x;
    if (typeof x === 'string') { bytes += Buffer.byteLength(x); if (bytes > 8192) throw new Error(); return x; }
    if (Array.isArray(x)) {
      if (x.length > 128 || Reflect.ownKeys(x).length !== x.length + 1) throw new Error();
      const out = [];
      for (let i = 0; i < x.length; i++) {
        const d = Object.getOwnPropertyDescriptor(x, String(i));
        if (!d || !Object.hasOwn(d, 'value')) throw new Error();
        out.push(copy(d.value, depth + 1));
      }
      return out;
    }
    if (!x || typeof x !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(x))) throw new Error();
    const keys = Reflect.ownKeys(x); if (keys.length > 64) throw new Error();
    const out = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string') throw new Error();
      bytes += Buffer.byteLength(key); if (bytes > 8192) throw new Error();
      const d = Object.getOwnPropertyDescriptor(x, key);
      if (!d || !Object.hasOwn(d, 'value')) throw new Error();
      out[key] = copy(d.value, depth + 1);
    }
    return out;
  }
  return copy(input, 0);
}
