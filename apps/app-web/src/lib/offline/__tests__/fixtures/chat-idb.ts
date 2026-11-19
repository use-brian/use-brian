/** A per-test, transactional store for the chat cache's IndexedDB entry port. */
export function chatIdbEntries(entries: Map<string, unknown>) {
  const read = (keys: readonly string[]) => Object.fromEntries(keys.map(key => [key, entries.get(key) ?? null]));
  return {
    idbReadEntries: async (keys: readonly string[]) => read(keys),
    idbUpdateEntries: async (keys: readonly string[], update: (values: Readonly<Record<string, unknown>>) => Record<string, unknown>) => {
      for (const [key, value] of Object.entries(update(read(keys)))) {
        if (value === undefined) entries.delete(key);
        else entries.set(key, value);
      }
      return read(keys);
    },
  };
}
