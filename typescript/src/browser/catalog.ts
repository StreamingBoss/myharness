import type { Agent, Skill } from '../catalog.js';
import type { CatalogPort } from '../runtime.js';
import { AGENT_TOOL_NAMES } from '../tools.js';
import { characters, lines, sliceCharacters } from '../format.js';
import { BrowserWorkspace } from './workspace.js';

export interface Library { agents: Record<string, string>; prompts: Record<string, string>; skills: Record<string, string> }

export class BrowserCatalog implements CatalogPort {
  constructor(private readonly library: Library, private readonly workspace: BrowserWorkspace) {}
  agents(): Record<string, Agent> {
    const result: Record<string, Agent> = {};
    const project = Object.fromEntries(Object.entries(this.workspace.project.files).filter(([name]) => /^agents\/[^/]+\.md$/.test(name)).map(([name, text]) => [name.slice(7, -3), text]));
    for (const [entries, source] of [[this.library.agents, 'harness'], [project, 'project']] as const) {
      for (const [name, original] of Object.entries(entries)) {
        const text = original.replace(/\r\n?/g, '\n'), index = text.indexOf('\n---\n');
        const tools = index < 0 ? [] : lines(text.slice(0, index)).filter(line => line.split(':')[0]!.trim() === 'tools').flatMap(line => line.slice(line.indexOf(':') + 1).split(',').map(tool => tool.trim()).filter(tool => AGENT_TOOL_NAMES.includes(tool)));
        result[name] = { prompt: (index < 0 ? text : text.slice(index + 5)).trim(), tools, source };
      }
    }
    return result;
  }
  prompts(): Record<string, string> { return { ...this.library.prompts }; }
  skills(): Record<string, Skill> {
    const result: Record<string, Skill> = {};
    const project = Object.fromEntries(Object.entries(this.workspace.project.files).filter(([name]) => /^skills\/[^/]+\/SKILL\.md$/.test(name)).map(([name, text]) => [name.split('/')[1]!, text]));
    for (const [entries, source] of [[this.library.skills, 'harness'], [project, 'project']] as const) {
      for (const [name, original] of Object.entries(entries)) {
        const text = original.replace(/\r\n?/g, '\n'), index = text.startsWith('---\n') ? text.indexOf('\n---\n', 4) : -1, meta: Record<string, string> = {};
        if (index >= 0) for (const line of lines(text.slice(4, index))) { const colon = line.indexOf(':'); if (colon >= 0) meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim(); }
        const skill = { name: meta.name || name, description: meta.description || '', body: (index < 0 ? text : text.slice(index + 5)).trim(), source }; result[skill.name] = skill;
      }
    }
    return result;
  }
  projectInstructions(): [string, string] | null {
    const text = this.workspace.project.files['AGENTS.md'];
    if (text === undefined) return null;
    return ['AGENTS.md', sliceCharacters(text, 10_000) + (characters(text) > 10_000 ? '\n[project instructions truncated]' : '')];
  }
}
