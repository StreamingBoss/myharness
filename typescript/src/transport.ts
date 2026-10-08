import { BackendError, type Harness, type TurnAction, type SpawnAgentInput, type GoalInput } from './harness.js';

/** Shared validation for HTTP and Worker callers. */
export function turnAction(value: Record<string, unknown>, chat: boolean): TurnAction {
  const useMemory = value.use_memory ?? value.useMemory;
  const askApproval = value.ask_approval ?? value.askApproval ?? true;
  if (typeof useMemory !== 'boolean' || typeof askApproval !== 'boolean' || !Array.isArray(value.tools) || !value.tools.every(name => typeof name === 'string') || typeof value.agent !== 'string' || typeof value.prompt !== 'string' || (chat && typeof value.message !== 'string')) throw new BackendError('Invalid turn settings');
  return { message: chat ? value.message as string : '', useMemory, askApproval, tools: value.tools as string[], agent: value.agent, prompt: value.prompt, ...(typeof value.session_id === 'string' ? { sessionId: value.session_id } : {}) };
}

export const AGENT_ACTIONS = ['getHarnessSettings', 'updateHarnessSettings', 'listAgents', 'spawnAgent', 'getAgentResult', 'waitAgent', 'interruptAgent', 'restartAgent', 'sendMessage', 'getGoal', 'startGoal', 'updateGoal', 'pauseGoal', 'resumeGoal', 'inspectRun', 'runEvents', 'cancelRun'];
export function agentQuery(params: URLSearchParams): Record<string, unknown> {
  const value: Record<string, unknown> = Object.fromEntries(params);
  for (const key of ['attempt', 'after']) if (params.has(key)) value[key] = Number(params.get(key));
  return value;
}
/** One validation/dispatch boundary for HTTP, Worker, and direct integrations. */
export async function agentAction(backend: Harness, action: string, value: Record<string, unknown>): Promise<unknown> {
  for (const key of ['id', 'message', 'task', 'objective', 'criteria', 'provider', 'model', 'agent', 'prompt', 'evidence', 'action']) if (value[key] !== undefined && typeof value[key] !== 'string') throw new BackendError(`${key} must be a string.`);
  for (const key of ['timeoutMs', 'maxRounds', 'maxRequests', 'revision', 'attempt', 'after']) if (value[key] !== undefined && !Number.isSafeInteger(value[key])) throw new BackendError(`${key} must be an integer.`);
  switch (action) {
    case 'getHarnessSettings': return backend.getHarnessSettings();
    case 'updateHarnessSettings': return backend.updateHarnessSettings(value);
    case 'listAgents': return backend.listAgents();
    case 'spawnAgent': return backend.spawnAgent(value as unknown as SpawnAgentInput);
    case 'getAgentResult': return backend.getAgentResult(String(value.id), value.attempt as number | undefined);
    case 'waitAgent': return backend.waitAgent(String(value.id));
    case 'interruptAgent': return backend.interruptAgent(String(value.id));
    case 'restartAgent': return backend.restartAgent(String(value.id), value.message as string | undefined, value.timeoutMs as number | undefined);
    case 'sendMessage': return backend.sendMessage(String(value.id), value.message as string);
    case 'getGoal': return { goal: backend.getGoal() ?? null };
    case 'startGoal': return { goal: await backend.startGoal({ ...value, ...(value.turn ? { turn: turnAction(value.turn as Record<string, unknown>, true) } : {}) } as unknown as GoalInput), run: backend.inspectRun() };
    case 'updateGoal': return { goal: await backend.updateGoal(Number(value.revision), String(value.action), value.evidence as string | undefined) };
    case 'pauseGoal': return { goal: await backend.pauseGoal(Number(value.revision)) };
    case 'resumeGoal': return { goal: await backend.resumeGoal(Number(value.revision), value.timeoutMs as number | undefined), run: backend.inspectRun() };
    case 'inspectRun': return { run: backend.inspectRun(value.id as string | undefined), goal: backend.getGoal() ?? null, children: backend.listAgents() };
    case 'runEvents': return { run: backend.inspectRun(String(value.id)), events: backend.runEvents(String(value.id), value.after as number | undefined) };
    case 'cancelRun': await backend.cancelRun(); return { ok: true };
    default: throw new BackendError('Unknown agent action', 404);
  }
}

export function agentRoute(method: string, route: string): { action: string; id?: string } | undefined {
  const direct: Record<string, string> = { 'GET /settings': 'getHarnessSettings', 'PATCH /settings': 'updateHarnessSettings', 'GET /agents': 'listAgents', 'POST /agents': 'spawnAgent', 'GET /goal': 'getGoal', 'POST /goal': 'startGoal', 'PATCH /goal': 'updateGoal', 'GET /runs': 'inspectRun', 'POST /runs/cancel': 'cancelRun' };
  if (direct[`${method} ${route}`]) return { action: direct[`${method} ${route}`]! };
  const match = route.match(/^\/(agents|runs|goal)\/([^/]+)\/(result|wait|restart|interrupt|message|events|pause|resume)$/);
  if (!match) return undefined;
  const operations: Record<string, string> = { 'GET agents/result': 'getAgentResult', 'POST agents/wait': 'waitAgent', 'POST agents/restart': 'restartAgent', 'POST agents/interrupt': 'interruptAgent', 'POST agents/message': 'sendMessage', 'GET runs/events': 'runEvents', 'POST goal/pause': 'pauseGoal', 'POST goal/resume': 'resumeGoal' };
  const action = operations[`${method} ${match[1]}/${match[3]}`];
  return action ? { action, id: decodeURIComponent(match[2]!) } : undefined;
}
