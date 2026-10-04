import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { SessionStore as SharedStore } from '../sessions.js';
import type { SessionRecord } from '../sessions.js';
export { sessionTitle, sessionSummary } from '../sessions.js';
export type { SessionRecord } from '../sessions.js';

const now = (): string => new Date().toISOString();

/** JSON session persistence compatible with the Python session envelope. */
export class SessionStore extends SharedStore {
  private pendingSave: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string) { super(); }

  override async save(record: SessionRecord): Promise<void> {
    const next = { ...record, updated_at: now() };
    Object.assign(record, next);
    const id = record.id, content = `${JSON.stringify(record, null, 2)}\n`;
    const persist = async () => {
      await mkdir(this.directory, { recursive: true });
      const target = this.file(id), temporary = `${target}.tmp`;
      await writeFile(temporary, content, 'utf8');
      await rename(temporary, target);
    };
    this.pendingSave = this.pendingSave.then(persist, persist);
    return this.pendingSave;
  }

  override async load(id: string): Promise<SessionRecord> {
    return this.validate(JSON.parse(await readFile(this.file(id), "utf8")) as unknown);
  }

  override async list(): Promise<SessionRecord[]> {
    try {
      const names = await readdir(this.directory);
      const records = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
        try { return this.validate(JSON.parse(await readFile(path.join(this.directory, name), "utf8")) as unknown); }
        catch { return undefined; }
      }));
      return records.filter((record): record is SessionRecord => record !== undefined)
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
    } catch { return []; }
  }

  private file(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error('Invalid session ID');
    return path.join(this.directory, `${id}.json`);
  }

}
