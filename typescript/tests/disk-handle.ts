import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LocalDirectory, LocalFile } from '../src/browser/local.js';

/** A `LocalDirectory` over a real folder, so real git and the browser's folder code can work on the same files. */
export class NodeFile implements LocalFile {
  readonly kind = 'file';
  constructor(readonly name: string, readonly location: string) {}
  async getFile() {
    const info = await stat(this.location);
    return { size: info.size, lastModified: info.mtimeMs, arrayBuffer: async () => { const bytes = await readFile(this.location); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; } };
  }
  async createWritable() {
    let staged: Uint8Array = new Uint8Array();
    return { write: async (data: string | Uint8Array) => { staged = typeof data === 'string' ? new TextEncoder().encode(data) : data; }, close: async () => writeFile(this.location, staged), abort: async () => undefined };
  }
}
export class NodeDirectory implements LocalDirectory {
  readonly kind = 'directory';
  constructor(readonly name: string, readonly location: string) {}
  async *entries(): AsyncIterable<[string, NodeDirectory | NodeFile]> {
    for (const entry of await readdir(this.location, { withFileTypes: true })) yield [entry.name, entry.isDirectory() ? new NodeDirectory(entry.name, path.join(this.location, entry.name)) : new NodeFile(entry.name, path.join(this.location, entry.name))];
  }
  private async kindOf(name: string): Promise<'file' | 'directory' | undefined> {
    try { return (await stat(path.join(this.location, name))).isDirectory() ? 'directory' : 'file'; } catch { return undefined; }
  }
  async getDirectoryHandle(name: string, options?: { create: boolean }): Promise<NodeDirectory> {
    let kind = await this.kindOf(name);
    if (!kind && options?.create) { await mkdir(path.join(this.location, name)); kind = 'directory'; }
    if (!kind) throw new DOMException('missing', 'NotFoundError');
    if (kind !== 'directory') throw new DOMException('not a directory', 'TypeMismatchError');
    return new NodeDirectory(name, path.join(this.location, name));
  }
  async getFileHandle(name: string, options?: { create: boolean }): Promise<NodeFile> {
    let kind = await this.kindOf(name);
    if (!kind && options?.create) { await writeFile(path.join(this.location, name), ''); kind = 'file'; }
    if (!kind) throw new DOMException('missing', 'NotFoundError');
    if (kind !== 'file') throw new DOMException('not a file', 'TypeMismatchError');
    return new NodeFile(name, path.join(this.location, name));
  }
  async removeEntry(name: string, options?: { recursive: boolean }): Promise<void> {
    if (!await this.kindOf(name)) throw new DOMException('missing', 'NotFoundError');
    await rm(path.join(this.location, name), { recursive: options?.recursive ?? false });
  }
  async queryPermission(): Promise<string> { return 'granted'; }
}

/** An in-memory folder with switches for failures, for tests that need to break the disk on purpose. */
export class DiskFile implements LocalFile {
  readonly kind = 'file'; bytes: Uint8Array; failed = false; aborted = false; oversized = false;
  constructor(readonly name: string, text = '') { this.bytes = new TextEncoder().encode(text); }
  async getFile() { return { size: this.oversized ? 10485761 : this.bytes.length, arrayBuffer: async () => this.bytes.slice().buffer as ArrayBuffer }; }
  async createWritable() {
    let staged: Uint8Array = new Uint8Array();
    return { write: async (data: string | Uint8Array) => { if (this.failed) throw new Error('disk full'); staged = typeof data === 'string' ? new TextEncoder().encode(data) : data; }, close: async () => { this.bytes = staged; }, abort: async () => { this.aborted = true; } };
  }
  text(): string { return new TextDecoder().decode(this.bytes); }
}
export class DiskDirectory implements LocalDirectory {
  readonly kind = 'directory'; permission = 'granted'; writePermission = 'granted'; children = new Map<string, DiskDirectory | DiskFile>();
  constructor(readonly name: string) {}
  async *entries(): AsyncIterable<[string, DiskDirectory | DiskFile]> { yield* this.children.entries(); }
  async queryPermission(options: { mode: 'read' | 'readwrite' }) { return options.mode === 'read' ? this.permission : this.writePermission; }
  async getDirectoryHandle(name: string, options?: { create: boolean }): Promise<DiskDirectory> {
    if (!this.children.has(name) && options?.create) this.children.set(name, new DiskDirectory(name));
    const entry = this.children.get(name); if (!entry) throw new DOMException('missing', 'NotFoundError'); if (entry.kind !== 'directory') throw new DOMException('not directory', 'TypeMismatchError'); return entry;
  }
  async getFileHandle(name: string, options?: { create: boolean }): Promise<DiskFile> {
    if (!this.children.has(name) && options?.create) this.children.set(name, new DiskFile(name));
    const entry = this.children.get(name); if (!entry) throw new DOMException('missing', 'NotFoundError'); if (entry.kind !== 'file') throw new DOMException('not file', 'TypeMismatchError'); return entry;
  }
  async removeEntry(name: string): Promise<void> { if (!this.children.delete(name)) throw new DOMException('missing', 'NotFoundError'); }
  add(name: string, text: string) { const file = new DiskFile(name, text); this.children.set(name, file); return file; }
}
