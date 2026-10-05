import { minimatch } from 'minimatch';
import { characters, lines, sliceCharacters } from '../format.js';
import { ESCAPE_NOTE, unescape } from '../workspace.js';
import type { WorkspacePort } from '../runtime.js';
import type { SessionRecord } from '../sessions.js';

export interface Project {
  format: 'myharness-project'; version: 1; root: string;
  files: Record<string, string>; directories: string[];
  sessions?: SessionRecord[];
  active_session_id?: string;
}
const SKIP = new Set(['.git', '.venv', 'node_modules', '__pycache__', '.mypy_cache']);

export function absolutePath(input: string): string {
  const parts: string[] = [];
  if (input.includes('\0') || input.includes('\\')) throw new Error('Use a virtual path with forward slashes');
  for (const part of input.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) throw new Error('Path leaves the virtual filesystem'); parts.pop(); }
    else parts.push(part);
  }
  return '/' + parts.join('/');
}

/** Text project files, isolated from the learner's operating-system filesystem. */
export class BrowserWorkspace implements WorkspacePort {
  readonly root: string;
  constructor(readonly project: Project, private readonly persist: (project: Project) => Promise<void>) {
    this.root = absolutePath(project.root);
  }
  async refresh(): Promise<void> {}
  pathFor(input: string): string {
    const candidate = input === this.root || input.startsWith(this.root + '/') ? input : this.root + '/' + input.replace(/^\/+/, '');
    const target = absolutePath(candidate);
    if (target !== this.root && !target.startsWith(this.root + '/')) throw new Error(`'${input}' is outside the project folder`);
    return target;
  }
  relative(input: string): string { return this.pathFor(input).slice(this.root.length + 1); }
  exists(input: string): boolean { const name = this.relative(input); return Object.hasOwn(this.project.files, name) || this.project.directories.includes(name); }
  isDirectory(input: string): boolean { return this.project.directories.includes(this.relative(input)); }
  async readText(input: string): Promise<string> {
    const name = this.relative(input);
    if (!Object.hasOwn(this.project.files, name)) throw new Error(`'${name}' is not a project file`);
    return this.project.files[name]!.replace(/\r\n?/g, '\n');
  }
  async writeText(input: string, text: string): Promise<void> {
    const name = this.relative(input), pieces = name.split('/');
    if (this.isDirectory(input)) throw new Error(`'${name}' is a folder`);
    const dirs = new Set(this.project.directories);
    for (let i = 1; i < pieces.length; i++) {
      const parent = pieces.slice(0, i).join('/');
      if (Object.hasOwn(this.project.files, parent)) throw new Error(`'${parent}' is a file, not a folder`);
      dirs.add(parent);
    }
    const next = { ...this.project, files: { ...this.project.files, [name]: text }, directories: [...dirs].sort() };
    await this.persist(next);
    Object.assign(this.project, next);
  }
  async listFiles(input = '.'): Promise<string> {
    const folder = this.relative(input);
    if (!this.isDirectory(input)) throw new Error(`'${input}' is not a folder`);
    const prefix = folder ? folder + '/' : '';
    const names = new Map<string, boolean>();
    for (const name of [...this.project.directories, ...Object.keys(this.project.files)]) {
      if (!name.startsWith(prefix) || name === folder) continue;
      const remaining = name.slice(prefix.length);
      if (remaining.includes('/')) continue;
      names.set(remaining, this.project.directories.includes(name));
    }
    return [...names.keys()].sort().map(name => name + (names.get(name) ? '/' : '')).join('\n') || '(empty folder)';
  }
  async readNumbered(input: string, startLine = 1, endLine?: number): Promise<string> {
    if (startLine < 1 || (endLine !== undefined && endLine < startLine)) throw new Error('use start_line >= 1 and end_line >= start_line');
    const source = lines(await this.readText(input));
    if (!source.length) return '(empty file)';
    if (startLine > source.length) return `[file has ${source.length} lines; start_line is past the end]`;
    const result: string[] = []; let size = 0, last = startLine - 1;
    for (let number = startLine; number <= Math.min(endLine ?? source.length, source.length); number++) {
      const line = `${String(number).padStart(4)}: ${source[number - 1]!}`;
      if (size + characters(line) + 1 > 9900) { if (!result.length) { result.push(sliceCharacters(line, 9850) + ' [long line truncated]'); last = number; } break; }
      result.push(line); size += characters(line) + 1; last = number;
    }
    if (last < source.length) result.push(`[lines ${startLine}-${last} of ${source.length}; call again with start_line=${last + 1}]`);
    return result.join('\n');
  }
  async findFiles(pattern: string): Promise<string> {
    const matches = this.files().filter(file => match(pattern, file));
    return [...matches.slice(0, 200), ...(matches.length > 200 ? [`[${matches.length - 200} more not shown]`] : [])].join('\n') || '(no files found)';
  }
  async search(pattern: string, input = '.', glob = '*'): Promise<string> {
    if (!pattern) throw new Error('pattern must not be empty');
    const matches: string[] = [];
    for (const file of this.files(input).filter(file => match(glob, file))) {
      let text: string;
      try { text = await this.readText(file); } catch { continue; }
      if (text.includes('\0')) continue;
      for (const [index, line] of lines(text).entries()) {
        if (!line.includes(pattern)) continue;
        if (matches.length === 100) return matches.join('\n') + '\n[more matches not shown; narrow path or glob]';
        matches.push(`${file}:${index + 1}: ${sliceCharacters(line, 500)}${characters(line) > 500 ? ' [line truncated]' : ''}`);
      }
    }
    return matches.join('\n') || '(no matches)';
  }
  async edit(input: string, oldText: string, newText: string): Promise<{ path: string; content: string; note?: string }> {
    if (!oldText) throw new Error('old_text is empty; use write_file to create a new file');
    const text = await this.readText(input); let note = '';
    if (!text.includes(oldText) && oldText.includes('\\n') && text.includes(unescape(oldText))) { oldText = unescape(oldText); newText = unescape(newText); note = ESCAPE_NOTE; }
    const count = text.split(oldText).length - 1;
    if (!count) throw new Error(`old_text was not found in '${input}'. Read the file again and copy the exact text, including spaces and indentation.`);
    if (count > 1) throw new Error(`old_text appears ${count} times in '${input}'. Include more surrounding lines so it matches only once.`);
    return { path: input, content: text.replace(oldText, () => newText), ...(note ? { note } : {}) };
  }
  private files(input = '.'): string[] {
    const name = this.relative(input);
    if (!this.exists(input)) throw new Error(`'${input}' does not exist in the project folder`);
    if (name.split('/').some(part => SKIP.has(part))) return [];
    if (!this.isDirectory(input)) return [name];
    return Object.keys(this.project.files).filter(file => (!name || file.startsWith(name + '/')) && !file.split('/').slice(0, -1).some(part => SKIP.has(part))).sort();
  }
}

function match(pattern: string, file: string): boolean {
  const options = { dot: true, noext: true, nobrace: true, nonegate: true, nocomment: true };
  const glob = pattern.replaceAll('/', '\u0001');
  return minimatch(file.split('/').at(-1)!, glob, options) || minimatch(file.replaceAll('/', '\u0001'), glob, options);
}

export function projectFromFiles(root: string, files: Record<string, string>): Project {
  const project: Project = { format: 'myharness-project', version: 1, root: absolutePath(root), files: Object.create(null) as Record<string, string>, directories: [''] };
  const workspace = new BrowserWorkspace(project, async () => {});
  const directories = new Set(['']);
  for (const [input, text] of Object.entries(files)) {
    if (typeof text !== 'string') throw new Error('Project files must contain text');
    const name = workspace.relative(input); if (!name) throw new Error('A file must have a name');
    project.files[name] = text;
    const parts = name.split('/'); for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
  }
  if ([...directories].some(name => Object.hasOwn(project.files, name))) throw new Error('A project path cannot be both a file and a folder');
  project.directories = [...directories].sort();
  return project;
}
