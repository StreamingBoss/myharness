import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { ChatMessage } from "../core.js";
import type { Snapshots } from './catalog.js';
import { TOOL_NAMES } from './tools.js';

export interface SessionRecord {
  format: "myharness-session";
  version: 1;
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
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

/** JSON session persistence compatible with the Python session envelope. */
export class SessionStore {
  constructor(private readonly directory: string) {}

  create(input: Pick<SessionRecord, "model" | "context_length" | "workspace">, name = "New session"): SessionRecord {
    const time = now();
    return { format: "myharness-session", version: 1, id: randomUUID().replaceAll("-", ""), name,
      created_at: time, updated_at: time, ...input, memory: [], last_prompt_tokens: 0,
      setup: { agent: "", prompt: "" }, snapshots: {}, project_instructions: null, events: [],
      settings: { use_memory: true, tools: [...TOOL_NAMES], ask_approval: true } };
  }

  async save(record: SessionRecord): Promise<void> {
    const next = { ...record, updated_at: now() };
    Object.assign(record, next);
    await mkdir(this.directory, { recursive: true });
    const target = this.file(record.id);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }

  async load(id: string): Promise<SessionRecord> {
    return this.validate(JSON.parse(await readFile(this.file(id), "utf8")) as unknown);
  }

  async list(): Promise<SessionRecord[]> {
    try {
      const names = await readdir(this.directory);
      const records = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
        try { return this.validate(JSON.parse(await readFile(path.join(this.directory, name), "utf8")) as unknown); }
        catch { return undefined; }
      }));
      return records.filter((record): record is SessionRecord => record !== undefined)
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
    } catch { return []; }
  }

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

  private file(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error('Invalid session ID');
    return path.join(this.directory, `${id}.json`);
  }

  async uniqueName(name: string, excludeId = ''): Promise<string> {
    const names = new Set((await this.list()).filter(record => record.id !== excludeId).map(record => record.name));
    let candidate = name, suffix = 2;
    while (names.has(candidate)) candidate = `${name} (${suffix++})`;
    return candidate;
  }

  async import(value: unknown): Promise<SessionRecord> {
    const record = structuredClone(this.validate(value));
    record.id = randomUUID().replaceAll('-', '');
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
