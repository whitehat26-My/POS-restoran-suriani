/**
 * Where the outbox lives between restarts.
 *
 * A narrow interface on purpose. The browser and the Android WebView both get
 * IndexedDB, so one implementation covers the till today and the tablet later;
 * tests get an in-memory one. When the device eventually wants native SQLite
 * for a bigger cache, it implements these five methods and nothing above it
 * changes.
 */
export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys with the given prefix, in lexicographic order. */
  keys(prefix: string): Promise<string[]>;
  clear(): Promise<void>;
}

/** For tests, and for a browser that has locked its storage away. */
export function memoryStore(): Store {
  const map = new Map<string, string>();
  return {
    async get<T>(key: string) {
      const raw = map.get(key);
      return raw === undefined ? undefined : (JSON.parse(raw) as T);
    },
    async put<T>(key: string, value: T) {
      map.set(key, JSON.stringify(value));
    },
    async delete(key: string) {
      map.delete(key);
    },
    async keys(prefix: string) {
      return [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    async clear() {
      map.clear();
    },
  };
}

/**
 * IndexedDB, one object store keyed by string.
 *
 * localStorage would have been simpler, but it is synchronous, capped around
 * 5 MB, and a busy service can queue a lot of orders during a long outage.
 * Losing an order because the quota filled is the one failure this whole
 * package exists to prevent.
 */
export function idbStore(dbName = "suriani-offline"): Store {
  const STORE = "kv";

  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexeddb open failed"));
    });

  const run = <T>(
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore) => IDBRequest,
  ): Promise<T> =>
    open().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const tx = db.transaction(STORE, mode);
          const req = body(tx.objectStore(STORE));
          req.onsuccess = () => resolve(req.result as T);
          req.onerror = () => reject(req.error ?? new Error("indexeddb failed"));
          tx.oncomplete = () => db.close();
        }),
    );

  return {
    get: <T>(key: string) => run<T | undefined>("readonly", (s) => s.get(key)),
    put: <T>(key: string, value: T) =>
      run<void>("readwrite", (s) => s.put(value, key)),
    delete: (key: string) => run<void>("readwrite", (s) => s.delete(key)),
    async keys(prefix: string) {
      const all = await run<IDBValidKey[]>("readonly", (s) => s.getAllKeys());
      return all
        .map(String)
        .filter((k) => k.startsWith(prefix))
        .sort();
    },
    clear: () => run<void>("readwrite", (s) => s.clear()),
  };
}
