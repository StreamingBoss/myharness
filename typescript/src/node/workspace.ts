import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { minimatch } from 'minimatch';
import { characters, sliceCharacters, lines } from '../format.js';
import { ESCAPE_NOTE, unescape } from '../workspace.js';
export { ESCAPE_NOTE, unescape } from '../workspace.js';

export const MAX_FILE_CHARS = 10_000;
const SKIP_DIRECTORIES = new Set([".git", ".venv", "node_modules", "__pycache__", ".mypy_cache"]);

/** Filesystem adapter that confines model-supplied paths to one workspace. */
export class WorkspaceAdapter {
  readonly root: string;

  constructor(root: string) { this.root = existsSync(root) ? realpathSync(root) : path.resolve(root); }

  exists(file: string): boolean { return existsSync(file); }
  isDirectory(file: string): boolean { return statSync(file).isDirectory(); }
  relative(file: string): string { return path.relative(this.root, file); }
  readText(file: string): Promise<string> { return readText(file); }
  async writeText(file: string, text: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text, 'utf8');
  }

  pathFor(input: string): string {
    const candidate = path.isAbsolute(input) && this.isInside(path.resolve(input))
      ? path.resolve(input)
      : path.resolve(this.root, input.replace(/^[/\\]+/, ""));
    let ancestor = candidate;
    while (!lstatSync(ancestor, { throwIfNoEntry: false }) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
    const resolved = path.resolve(realpathSync(ancestor), path.relative(ancestor, candidate));
    if (!this.isInside(resolved)) throw new Error(`'${input}' is outside the project folder`);
    return resolved;
  }

  async listFiles(input = "."): Promise<string> {
    const entries = await readdir(this.pathFor(input), { withFileTypes: true });
    if (!entries.length) return "(empty folder)";
    return entries.sort((left, right) => Number(left.name > right.name) - Number(left.name < right.name))
      .map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name).join("\n");
  }

  async readNumbered(input: string, startLine = 1, endLine?: number): Promise<string> {
    if (startLine < 1 || (endLine !== undefined && endLine < startLine)) {
      throw new Error("use start_line >= 1 and end_line >= start_line");
    }
    const sourceLines = lines(await readFile(this.pathFor(input), 'utf8'));
    if (!sourceLines.length) return '(empty file)';
    if (startLine > sourceLines.length) return `[file has ${sourceLines.length} lines; start_line is past the end]`;
    const result: string[] = [];
    let size = 0;
    let last = startLine - 1;
    for (let number = startLine; number <= Math.min(endLine ?? sourceLines.length, sourceLines.length); number += 1) {
      const line = `${String(number).padStart(4)}: ${sourceLines[number - 1]!}`;
      if (size + characters(line) + 1 > MAX_FILE_CHARS - 100) {
        if (!result.length) {
          result.push(`${sliceCharacters(line, MAX_FILE_CHARS - 150)} [long line truncated]`);
          last = number;
        }
        break;
      }
      result.push(line);
      size += characters(line) + 1;
      last = number;
    }
    if (last < sourceLines.length) result.push(`[lines ${startLine}-${last} of ${sourceLines.length}; call again with start_line=${last + 1}]`);
    return result.join("\n");
  }

  async findFiles(pattern: string): Promise<string> {
    const matcher = this.glob(pattern);
    const matches = (await this.projectFiles()).filter((file) => matcher(path.basename(file)) || matcher(file)).sort();
    return [...matches.slice(0, 200), ...(matches.length > 200 ? [`[${matches.length - 200} more not shown]`] : [])].join("\n") || "(no files found)";
  }

  async search(pattern: string, input = ".", glob = "*"): Promise<string> {
    if (!pattern) throw new Error("pattern must not be empty");
    const matcher = this.glob(glob);
    const start = this.pathFor(input);
    const files = await this.projectFiles(start);
    const matches: string[] = [];
    for (const relative of files) {
      if (!matcher(path.basename(relative)) && !matcher(relative)) continue;
      try {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(this.pathFor(relative)));
        if (text.includes("\0")) continue;
        for (const [index, line] of lines(text).entries()) {
          if (!line.includes(pattern)) continue;
          if (matches.length === 100) return `${matches.join("\n")}\n[more matches not shown; narrow path or glob]`;
          matches.push(`${relative}:${index + 1}: ${sliceCharacters(line, 500)}${characters(line) > 500 ? " [line truncated]" : ""}`);
        }
      } catch { continue; }
    }
    return matches.join("\n") || "(no matches)";
  }

  async edit(input: string, oldText: string, newText: string): Promise<{ path: string; content: string; note?: string }> {
    if (!oldText) throw new Error("old_text is empty; use write_file to create a new file");
    const target = this.pathFor(input);
    const text = await readText(target);
    let note = '';
    if (!text.includes(oldText) && oldText.includes('\\n') && text.includes(unescape(oldText))) {
      oldText = unescape(oldText); newText = unescape(newText); note = ESCAPE_NOTE;
    }
    const count = text.split(oldText).length - 1;
    if (!count) throw new Error(`old_text was not found in '${input}'. Read the file again and copy the exact text, including spaces and indentation.`);
    if (count > 1) throw new Error(`old_text appears ${count} times in '${input}'. Include more surrounding lines so it matches only once.`);
    return { path: input, content: text.replace(oldText, () => newText), ...(note ? { note } : {}) };
  }

  private async projectFiles(input = this.root): Promise<string[]> {
    const directory = this.pathFor(input);
    const results: string[] = [];
    if (path.relative(this.root, directory).split(path.sep).some(part => SKIP_DIRECTORIES.has(part))) return [];
    if ((await stat(directory)).isFile()) return [path.relative(this.root, directory)];
    const visit = async (folder: string): Promise<void> => {
      const entries = await readdir(folder, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => Number(left.name > right.name) - Number(left.name < right.name))) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        const full = path.join(folder, entry.name);
        if (entry.isSymbolicLink()) {
          try {
            if (this.isInside(realpathSync(full)) && statSync(full).isFile()) results.push(path.relative(this.root, full));
          } catch { /* Broken links are not searchable files. */ }
          continue;
        }
        if (entry.isDirectory()) await visit(full);
        else if (entry.isFile()) results.push(path.relative(this.root, full));
      }
    };
    await visit(directory);
    return results;
  }

  private glob(pattern: string): (value: string) => boolean {
    // Python fnmatch allows '*' across '/', unlike most JS glob libraries.
    return value => minimatch(value.replaceAll('/', '\u0001'), pattern.replaceAll('/', '\u0001'), { dot: true, noext: true, nobrace: true, nonegate: true, nocomment: true });
  }

  private isInside(candidate: string): boolean {
    const relative = path.relative(this.root, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  }
}

/** Match Python's strict UTF-8 text reads and universal newline handling. */
export async function readText(file: string): Promise<string> {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(file)).replace(/\r\n?/g, '\n');
}
