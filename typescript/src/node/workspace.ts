import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const MAX_FILE_CHARS = 10_000;

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

  private isInside(candidate: string): boolean {
    const relative = path.relative(this.root, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  }
}
