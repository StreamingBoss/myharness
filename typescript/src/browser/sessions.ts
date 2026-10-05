import { SessionStore, type SessionRecord } from '../sessions.js';
import { BrowserStorage } from './storage.js';

export class BrowserSessions extends SessionStore {
  private pending: Promise<void> = Promise.resolve();
  private lastSavedAt = 0;
  constructor(private readonly storage: BrowserStorage) { super(); }
  override async save(record: SessionRecord): Promise<void> {
    // Startup selects the latest session; saves in one millisecond must stay ordered.
    this.lastSavedAt = Math.max(Date.now(), this.lastSavedAt + 1);
    record.updated_at = new Date(this.lastSavedAt).toISOString();
    const snapshot = structuredClone(record);
    const persist = () => this.storage.put('sessions', snapshot.id, snapshot);
    this.pending = this.pending.then(persist, persist);
    return this.pending;
  }
  override async load(id: string): Promise<SessionRecord> { return this.validate(await this.storage.get('sessions', id)); }
  override async list(): Promise<SessionRecord[]> {
    const records = (await this.storage.all<unknown>('sessions')).flatMap(value => {
      try { return [this.validate(value)]; } catch { return []; }
    });
    return records.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }
}
