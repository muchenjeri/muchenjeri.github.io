// Minimal transactional key-value storage with two backends: IndexedDB (browser) and memory (tests).
// Inside tx(), only use the t.* calls: an IndexedDB transaction commits as soon as it has no
// pending requests, so awaiting anything else would end it early.

const STORES = {
  entries: { keyPath: 'id' },
  attachments: { keyPath: 'id', indexes: ['entryId', 'fileName'] },
  blobs: { keyPath: 'fileName' },
  meta: { keyPath: 'key' },
};

const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

export async function openIdb(name = 'muchenjeri-journal') {
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => {
      for (const [store, def] of Object.entries(STORES)) {
        const os = r.result.createObjectStore(store, { keyPath: def.keyPath });
        for (const ix of def.indexes ?? []) os.createIndex(ix, ix);
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return {
    async tx(mode, fn) {
      const t = db.transaction(Object.keys(STORES), mode, { durability: 'strict' });
      const done = new Promise((resolve, reject) => {
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error ?? new Error('Transaction aborted'));
      });
      const api = {
        get: (s, k) => req(t.objectStore(s).get(k)),
        put: (s, v) => req(t.objectStore(s).put(v)),
        delete: (s, k) => req(t.objectStore(s).delete(k)),
        all: (s) => req(t.objectStore(s).getAll()),
        byIndex: (s, ix, v) => req(t.objectStore(s).index(ix).getAll(v)),
        count: (s, ix, v) => req(t.objectStore(s).index(ix).count(v)),
      };
      let result;
      try {
        result = await fn(api);
      } catch (e) {
        try { t.abort(); } catch { /* already finished */ }
        throw e;
      }
      await done;
      return result;
    },
  };
}

/** In-memory backend for tests. Transactions run one at a time and roll back on error. */
export function memoryStore() {
  let data = Object.fromEntries(Object.keys(STORES).map((s) => [s, new Map()]));
  let queue = Promise.resolve();
  const clone = (v) => (v && typeof v === 'object' && !(v instanceof Blob) ? structuredClone(v) : v);
  return {
    data: () => data,
    tx(mode, fn) {
      const run = async () => {
        const snapshot = Object.fromEntries(Object.entries(data).map(([s, m]) => [s, new Map(m)]));
        const key = (s, v) => v[STORES[s].keyPath];
        const api = {
          get: async (s, k) => clone(data[s].get(k)),
          put: async (s, v) => { data[s].set(key(s, v), clone(v)); },
          delete: async (s, k) => { data[s].delete(k); },
          all: async (s) => [...data[s].values()].map(clone),
          byIndex: async (s, ix, v) => [...data[s].values()].filter((x) => x[ix] === v).map(clone),
          count: async (s, ix, v) => [...data[s].values()].filter((x) => x[ix] === v).length,
        };
        try {
          return await fn(api);
        } catch (e) {
          data = snapshot;
          throw e;
        }
      };
      const p = queue.then(run, run);
      queue = p.catch(() => {});
      return p;
    },
  };
}
