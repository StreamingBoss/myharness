import type { ChatMessage } from './core.js';
import type { SessionRecord } from './sessions.js';

/**
 * Step-by-step replay of a recorded session. A session already stores every harness event; this module only
 * decides what one "step" is and where a replay may be continued with a model. It never calls a model.
 */
export interface ReplayStep {
  /** The event type that ends the step (`request`, `response`, `tool`, `chat_user`, ...). */
  type: string;
  /** First and last event index of the step, inclusive. A reply's streamed chunks belong to the step of its `response`. */
  first: number;
  last: number;
  /** Number of memory messages kept when the session is continued from the end of this step; absent where continuing is not offered. */
  memory?: number;
}

type EventRecord = Record<string, unknown>;
const STREAMED = new Set(['chunk', 'thinking']);
/** Context trimming and compaction rewrite old memory, so memory cannot be rebuilt for an earlier step. */
const REWRITES_MEMORY = new Set(['trim', 'compact']);

function isFinalAnswer(message: ChatMessage | undefined): boolean {
  return message !== undefined && message.role === 'assistant' && !(message.tool_calls?.length);
}

/** Split events into steps: one step per event, except that the streamed chunks and thinking of a reply join the event that ends them. */
export function replaySteps(events: EventRecord[]): ReplayStep[] {
  const steps: ReplayStep[] = [];
  let streamStart = -1;
  events.forEach((event, index) => {
    if (STREAMED.has(String(event.type))) { if (streamStart < 0) streamStart = index; return; }
    steps.push({ type: String(event.type), first: streamStart < 0 ? index : streamStart, last: index });
    streamStart = -1;
  });
  if (streamStart >= 0) steps.push({ type: 'chunk', first: streamStart, last: events.length - 1 });
  return steps;
}

/**
 * Steps of a session, with `memory` set on every step where a replay can be continued: the end of a turn, where the last
 * message in memory is the model's final answer. Memory is rebuilt by counting the messages each event added; the count
 * is only trusted when it matches the session's saved memory exactly, so an unusual session offers continuing from its end
 * only (or not at all) instead of a wrong state.
 */
export function replayPlan(record: Pick<SessionRecord, 'events' | 'memory'>): ReplayStep[] {
  const steps = replaySteps(record.events);
  const lengths: number[] = [];
  let count = 0, rewritten = false, segment = 0;
  for (const [index, step] of steps.entries()) {
    const event = record.events[step.last]!;
    if (event.type === 'reset') { count = 0; segment = index + 1; }
    else if (event.type === 'context' && REWRITES_MEMORY.has(String(event.action))) rewritten = true;
    else if (['chat_user', 'response', 'tool', 'guard'].includes(String(event.type))) count++;
    lengths.push(count);
  }
  if (rewritten || count !== record.memory.length) return steps;
  steps.forEach((step, index) => {
    // The saved memory is the one after the last reset: earlier segments left no messages to rebuild from.
    if (index >= segment && isFinalAnswer(record.memory[lengths[index]! - 1]) && step.type === 'response') step.memory = lengths[index]!;
  });
  return steps;
}

/** The session as it stood at the end of a step: the events up to it and the memory it had. Throws where continuing is not offered. */
export function sessionAtStep(record: SessionRecord, stepIndex: number): SessionRecord {
  const step = replayPlan(record)[stepIndex];
  if (!step || step.memory === undefined) throw new Error('This session cannot be continued from this step.');
  const events = structuredClone(record.events.slice(0, step.last + 1));
  const response = [...events].reverse().find(event => event.type === 'response' && typeof event.tokens_in === 'number');
  const { orchestration: _goal, parent_session_id: _parent, child_task: _task, ...rest } = structuredClone(record);
  return { ...rest, events, memory: structuredClone(record.memory.slice(0, step.memory)), last_prompt_tokens: (response?.tokens_in as number | undefined) ?? 0 };
}
