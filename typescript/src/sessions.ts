import type { Provider } from './model.js';
import type { ChatMessage } from './core.js';
import type { Snapshots } from './catalog.js';
import { TOOL_NAMES } from './tools.js';
export interface SessionRecord {
  format: "myharness-session";
  version: 1;
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  provider?: Provider;
  max_output_tokens?: number;
  model: string;
  context_length: number;
  workspace: string;
  memory: ChatMessage[];
  last_prompt_tokens: number;
  setup: { agent: string; prompt: string };
  snapshots: Snapshots;
  missing_workspace?: boolean;
  project_instructions: [string, string] | null;
  events: Record<string, unknown>[];
  settings: { use_memory: boolean; tools: string[]; ask_approval: boolean };
}

const now = (): string => new Date().toISOString();
export function createSession(input: Pick<SessionRecord, "model" | "context_length" | "workspace" | "provider" | "max_output_tokens">, name = "New session"): SessionRecord {
    const time = now();
    return { format: "myharness-session", version: 1, id: crypto.randomUUID().replaceAll("-", ""), name,
      created_at: time, updated_at: time, ...input, memory: [], last_prompt_tokens: 0,
      setup: { agent: "", prompt: "" }, snapshots: {}, project_instructions: null, events: [],
      settings: { use_memory: true, tools: [...TOOL_NAMES], ask_approval: true } };
  }

export interface SessionPort {
  save(record: SessionRecord): Promise<void>;
  load(id: string): Promise<SessionRecord>;
  list(): Promise<SessionRecord[]>;
  uniqueName(name: string, excludeId?: string): Promise<string>;
  import(value: unknown): Promise<SessionRecord>;
}

export abstract class SessionStore implements SessionPort {
  create = createSession;
  abstract save(record: SessionRecord): Promise<void>;
  abstract load(id: string): Promise<SessionRecord>;
  abstract list(): Promise<SessionRecord[]>;
  validate(value: unknown): SessionRecord {
    if (typeof value !== "object" || value === null) throw new Error("not a supported myharness session export");
    const record = value as Partial<SessionRecord>;
    if (record.format !== "myharness-session" || record.version !== 1 || typeof record.id !== "string" ||
      typeof record.name !== "string" || typeof record.model !== "string" || typeof record.context_length !== "number" ||
      typeof record.workspace !== "string" || !Array.isArray(record.memory) || !Array.isArray(record.events) ||
      typeof record.settings !== "object" || record.settings === null || typeof record.setup !== "object" || record.setup === null ||
      typeof record.snapshots !== "object" || record.snapshots === null) throw new Error("not a supported myharness session export");
    return record as SessionRecord;
  }

  async uniqueName(name: string, excludeId = ''): Promise<string> {
    const names = new Set((await this.list()).filter(record => record.id !== excludeId).map(record => record.name));
    let candidate = name, suffix = 2;
    while (names.has(candidate)) candidate = `${name} (${suffix++})`;
    return candidate;
  }

  async import(value: unknown): Promise<SessionRecord> {
    const record = structuredClone(this.validate(value));
    record.id = crypto.randomUUID().replaceAll('-', '');
    record.name = await this.uniqueName(`${record.name} (imported)`);
    record.created_at = now();
    await this.save(record);
    return record;
  }
}

export function sessionTitle(text: string): string {
  const compact = text.trim().split(/\s+/).join(' ');
  return [...compact].slice(0, 60).join('') + ([...compact].length > 60 ? '…' : '');
}

export function sessionSummary(record: SessionRecord): Record<string, string> {
  let name = record.name;
  if (name === 'New session') {
    const event = record.events.find(event => event.type === 'chat_user' && typeof event.content === 'string');
    const message = record.memory.find(message => message.role === 'user');
    name = sessionTitle(String(event?.content ?? message?.content ?? '')) || name;
  }
  return { id: record.id, name, created_at: record.created_at, updated_at: record.updated_at, workspace: record.workspace, model: record.model };
}

