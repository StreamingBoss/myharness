export interface StoragePort {
  get<T>(store: string, key: string): Promise<T | undefined>;
  all<T>(store: string): Promise<T[]>;
  put(store: string, key: string, value: unknown): Promise<void>;
  close(): void;
}

/** Session-only storage: never opens IndexedDB, including during initialization. */
export class MemoryStorage implements StoragePort {
  private readonly stores = new Map<string, Map<string, unknown>>();
  async get<T>(store: string, key: string): Promise<T | undefined> { return structuredClone(this.stores.get(store)?.get(key)) as T | undefined; }
  async all<T>(store: string): Promise<T[]> { return structuredClone([...this.stores.get(store)?.values() ?? []]) as T[]; }
  async put(store: string, key: string, value: unknown): Promise<void> {
    let target = this.stores.get(store);
    if (!target) { target = new Map(); this.stores.set(store, target); }
    target.set(key, structuredClone(value));
  }
  close(): void { this.stores.clear(); }
}

/** IndexedDB lives in the backend Worker, independently of page components. */
export class BrowserStorage implements StoragePort {
  private constructor(private readonly database: IDBDatabase) {}

  static async open(name = 'myharness-browser-v1', factory = indexedDB): Promise<BrowserStorage> {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => { for (const store of ['sessions', 'projects', 'settings']) request.result.createObjectStore(store); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Browser storage is blocked by another open version. Close other harness tabs and retry.'));
    });
    database.onversionchange = () => database.close();
    return new BrowserStorage(database);
  }

  async get<T>(store: string, key: string): Promise<T | undefined> {
    return this.read<T | undefined>(this.database.transaction(store).objectStore(store).get(key));
  }
  async all<T>(store: string): Promise<T[]> {
    return this.read<T[]>(this.database.transaction(store).objectStore(store).getAll());
  }
  private read<T>(request: IDBRequest): Promise<T> {
    return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result as T); request.onerror = () => reject(request.error); });
  }
  async put(store: string, key: string, value: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction(store, 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error('Browser storage transaction aborted'));
      transaction.objectStore(store).put(value, key);
    });
  }
  close(): void { this.database.close(); }
}
