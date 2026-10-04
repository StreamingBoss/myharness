/** IndexedDB lives in the backend Worker, independently of page components. */
export class BrowserStorage {
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
