import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { characters, lines, sliceCharacters } from '../format.js';
import { TOOL_NAMES } from './tools.js';
import { WorkspaceAdapter } from './workspace.js';

import type { Agent, Skill } from '../catalog.js';
export { skillsSection, skillContext } from '../catalog.js';
export type { Agent, Skill, Snapshots } from '../catalog.js';

export class Catalog {
  constructor(readonly root: string, readonly workspace: WorkspaceAdapter) {}

  agents(): Record<string, Agent> {
    const result: Record<string, Agent> = {};
    for (const [folder, source] of [[path.join(this.root, 'agents'), 'harness'], [path.join(this.workspace.root, 'agents'), 'project']]) {
      for (const file of this.files(folder!)) {
        if (!file.endsWith('.md')) continue;
        const text = readFileSync(path.join(folder!, file), 'utf8').replaceAll('\r\n', '\n');
        const index = text.indexOf('\n---\n');
        const tools = index < 0 ? [] : lines(text.slice(0, index)).filter(line => line.split(':')[0]!.trim() === 'tools').flatMap(line => line.slice(line.indexOf(':') + 1).split(',').map(name => name.trim()).filter(name => TOOL_NAMES.includes(name)));
        result[path.basename(file, '.md')] = { prompt: (index < 0 ? text : text.slice(index + 5)).trim(), tools, source: source! };
      }
    }
    return result;
  }

  prompts(): Record<string, string> {
    const directory = path.join(this.root, 'prompts');
    return Object.fromEntries(this.files(directory).filter(file => file.endsWith('.md')).map(file => [path.basename(file, '.md'), readFileSync(path.join(directory, file), 'utf8')]));
  }

  skills(): Record<string, Skill> {
    const result: Record<string, Skill> = {};
    for (const [folder, source] of [[path.join(this.root, 'skills'), 'harness'], [path.join(this.workspace.root, 'skills'), 'project']]) {
      for (const name of this.files(folder!)) {
        const file = path.join(folder!, name, 'SKILL.md');
        if (!existsSync(file)) continue;
        const text = readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
        const index = text.startsWith('---\n') ? text.indexOf('\n---\n', 4) : -1;
        const meta: Record<string, string> = {};
        if (index >= 0) for (const line of lines(text.slice(4, index))) {
          const colon = line.indexOf(':');
          if (colon >= 0) meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
        }
        const skill = { name: meta.name || name, description: meta.description || '', body: (index < 0 ? text : text.slice(index + 5)).trim(), source: source! };
        result[skill.name] = skill;
      }
    }
    return result;
  }

  projectInstructions(): [string, string] | null {
    const file = this.workspace.pathFor('AGENTS.md');
    if (!existsSync(file) || !statSync(file).isFile()) return null;
    const text = readFileSync(file, 'utf8');
    return ['AGENTS.md', sliceCharacters(text, 10_000) + (characters(text) > 10_000 ? '\n[project instructions truncated]' : '')];
  }

  private files(directory: string): string[] { return existsSync(directory) ? readdirSync(directory).sort() : []; }
}
