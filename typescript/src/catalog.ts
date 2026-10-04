import type { ChatMessage } from './core.js';
import { lines } from './format.js';
export interface Agent { prompt: string; tools: string[]; source: string }
export interface Skill { name: string; description: string; body: string; source: string }
export interface Snapshots { prompt?: { name: string; text: string }; agent?: { name: string; value: Agent | null }; skills?: Record<string, Skill> }

export function skillsSection(skills: Record<string, Skill>): string {
  if (!Object.keys(skills).length) return '';
  return '# Skills\n\nSkills are detailed instructions for specific tasks. When a task matches a skill\'s description, call use_skill with its name before starting, then follow what it returns.\n\n' + Object.values(skills).map(skill => `- ${skill.name}: ${skill.description}`).join('\n');
}

export function skillContext(context: ChatMessage[], skills: Record<string, Skill>): Record<string, unknown> {
  const contents = context.map(message => message.content);
  for (const message of context) if (message.role === 'tool' && message.tool_name === 'read_file') contents.push(lines(message.content).map(line => line.replace(/^\s*\d+: /, '')).join('\n'));
  return Object.fromEntries(Object.entries(skills).map(([name, skill]) => [name, {
    listed: context.some(message => message.role === 'system' && message.content.includes(`- ${name}: ${skill.description}`)),
    body_loaded: Boolean(skill.body) && contents.some(content => content.includes(skill.body)),
    loaded_lines: skill.body.split('\n').flatMap((line, index) => line.trim() && contents.some(content => content.includes(line)) ? [index] : []),
  }]));
}

