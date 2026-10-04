import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export const MAX_FILE_CHARS = 10_000;
const SKIP_DIRECTORIES = new Set([".git", ".venv", "node_modules", "__pycache__", ".mypy_cache"]);

/** Filesystem adapter that confines model-supplied paths to one workspace. */
export class WorkspaceAdapter {
  readonly root: string;

  constructor(root: string) { this.root = path.resolve(root); }

  pathFor(input: string): string {
    const candidate = path.isAbsolute(input) && this.isInside(path.resolve(input))
      ? path.resolve(input)
      : path.resolve(this.root, input.replace(/^[/\\]+/, ""));
    if (!this.isInside(candidate)) throw new Error(`'${input}' is outside the project folder`);
    return candidate;
  }

  async listFiles(input = "."): Promise<string> {
    const entries = await readdir(this.pathFor(input), { withFileTypes: true });
    if (!entries.length) return "(empty folder)";
    return entries.sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name).join("\n");
  }

  async readNumbered(input: string, startLine = 1, endLine?: number): Promise<string> {
    if (startLine < 1 || (endLine !== undefined && endLine < startLine)) {
      throw new Error("use start_line >= 1 and end_line >= start_line");
    }
    const lines = (await readFile(this.pathFor(input), "utf8")).split(/\r?\n/);
    if (lines.length === 1 && lines[0] === "") return "(empty file)";
    if (startLine > lines.length) return `[file has ${lines.length} lines; start_line is past the end]`;
    const result: string[] = [];
    let size = 0;
    let last = startLine - 1;
    for (let number = startLine; number <= Math.min(endLine ?? lines.length, lines.length); number += 1) {
      const line = `${String(number).padStart(4)}: ${lines[number - 1] ?? ""}`;
      if (size + line.length + 1 > MAX_FILE_CHARS - 100) {
        if (!result.length) result.push(`${line.slice(0, MAX_FILE_CHARS - 150)} [long line truncated]`);
        last = number;
        break;
      }
      result.push(line);
      size += line.length + 1;
      last = number;
    }
    if (last < lines.length) result.push(`[lines ${startLine}-${last} of ${lines.length}; call again with start_line=${last + 1}]`);
    return result.join("\n");
  }

  async findFiles(pattern: string): Promise<string> {
    const matcher = this.glob(pattern);
    const matches = (await this.projectFiles()).filter((file) => matcher(path.basename(file)) || matcher(file));
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
        const text = await readFile(path.join(this.root, relative), "utf8");
        if (text.includes("\0")) continue;
        for (const [index, line] of text.split(/\r?\n/).entries()) {
          if (!line.includes(pattern)) continue;
          if (matches.length === 100) return `${matches.join("\n")}\n[more matches not shown; narrow path or glob]`;
          matches.push(`${relative}:${index + 1}: ${line.slice(0, 500)}${line.length > 500 ? " [line truncated]" : ""}`);
        }
      } catch { continue; }
    }
    return matches.join("\n") || "(no matches)";
  }

  async edit(input: string, oldText: string, newText: string): Promise<{ path: string; content: string }> {
    if (!oldText) throw new Error("old_text is empty; use write_file to create a new file");
    const target = this.pathFor(input);
    const text = await readFile(target, "utf8");
    const count = text.split(oldText).length - 1;
    if (!count) throw new Error(`old_text was not found in '${input}'. Read the file again and copy the exact text, including spaces and indentation.`);
    if (count > 1) throw new Error(`old_text appears ${count} times in '${input}'. Include more surrounding lines so it matches only once.`);
    return { path: input, content: text.replace(oldText, newText) };
  }

  private async projectFiles(input = this.root): Promise<string[]> {
    const directory = this.pathFor(input);
    const results: string[] = [];
    if ((await stat(directory)).isFile()) return [path.relative(this.root, directory)];
    const visit = async (folder: string): Promise<void> => {
      const entries = await readdir(folder, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.isSymbolicLink() || SKIP_DIRECTORIES.has(entry.name)) continue;
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) await visit(full);
        else if (entry.isFile()) results.push(path.relative(this.root, full));
      }
    };
    await visit(directory);
    return results;
  }

  private glob(pattern: string): (value: string) => boolean {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
    return (value) => new RegExp(`^${escaped}$`).test(value);
  }

  private isInside(candidate: string): boolean {
    const relative = path.relative(this.root, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  }
}
