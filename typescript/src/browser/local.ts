import { BrowserWorkspace, type Project } from './workspace.js';

export interface LocalFile {
  readonly kind: 'file'; readonly name: string;
  getFile(): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  createWritable(): Promise<{ write(text: string): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>;
}
export interface LocalDirectory {
  readonly kind: 'directory'; readonly name: string;
  entries(): AsyncIterable<[string, LocalFile | LocalDirectory]>;
  getDirectoryHandle(name: string, options?: { create: boolean }): Promise<LocalDirectory>;
  getFileHandle(name: string, options?: { create: boolean }): Promise<LocalFile>;
  queryPermission(options: { mode: 'read' | 'readwrite' }): Promise<string>;
}
export type StoredProject = Project & { handle?: LocalDirectory };
const SKIP = new Set(['.git', '.venv', 'node_modules', '__pycache__', '.mypy_cache']);
const MAX_BYTES = 10 * 1024 * 1024;

/** User-granted directory handles, usable inside a Worker after the picker grants access. */
export class LocalWorkspace extends BrowserWorkspace {
  private readonly observed = new Map<string, string>();
  constructor(project: Project, readonly handle: LocalDirectory) { super(project, async () => {}); }
  override async refresh(): Promise<void> {
    if (await this.handle.queryPermission({ mode: 'read' }) !== 'granted') throw new Error('Local folder access is required. Open the local folder again to grant browser permission.');
    const files = Object.create(null) as Record<string, string>, directories = [''];
    const visit = async (directory: LocalDirectory, prefix: string): Promise<void> => {
      for await (const [name, entry] of directory.entries()) {
        const relative = prefix + name;
        if (entry.kind === 'directory') {
          directories.push(relative);
          if (!SKIP.has(name)) await visit(entry, relative + '/');
        } else {
          files[relative] = '';
          if (relative === 'AGENTS.md' || /^agents\/[^/]+\.md$/.test(relative) || /^skills\/[^/]+\/SKILL\.md$/.test(relative)) files[relative] = await this.decode(entry);
        }
      }
    };
    await visit(this.handle, '');
    this.project.files = files; this.project.directories = directories.sort();
  }
  override async readText(input: string): Promise<string> {
    const name = this.relative(input), file = await this.file(name, false);
    const text = await this.decode(file); this.observed.set(name, text); return text;
  }
  override async writeText(input: string, text: string): Promise<void> {
    const name = this.relative(input);
    if (await this.handle.queryPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Write permission is required. Open the local folder again with read/write access.');
    let current: string | undefined;
    try { current = await this.decode(await this.file(name, false)); }
    catch (error) { if ((error as Error).name !== 'NotFoundError') throw error; }
    const expected = this.exists(input) ? this.observed.get(name) : undefined;
    if (current !== expected) throw new Error(`'${name}' changed on disk after it was read. Read it again and propose a new edit.`);
    const file = await this.file(name, true), stream = await file.createWritable();
    try { await stream.write(text); await stream.close(); }
    catch (error) { await stream.abort(); throw error; }
    this.project.files[name] = text; this.observed.set(name, text);
    const parts = name.split('/'); for (let i = 1; i < parts.length; i++) { const parent = parts.slice(0, i).join('/'); if (!this.project.directories.includes(parent)) this.project.directories.push(parent); }
  }
  private async file(name: string, create: boolean): Promise<LocalFile> {
    const parts = name.split('/'); let directory = this.handle;
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create });
    return directory.getFileHandle(parts.at(-1)!, { create });
  }
  private async decode(handle: LocalFile): Promise<string> {
    const file = await handle.getFile();
    if (file.size > MAX_BYTES) throw new Error(`'${handle.name}' exceeds the browser's 10 MiB text-file limit`);
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()).replace(/\r\n?/g, '\n');
  }
}
