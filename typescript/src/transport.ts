import { BackendError, type TurnAction } from './harness.js';

/** Shared validation for HTTP and Worker callers. */
export function turnAction(value: Record<string, unknown>, chat: boolean): TurnAction {
  const useMemory = value.use_memory ?? value.useMemory;
  const askApproval = value.ask_approval ?? value.askApproval ?? true;
  if (typeof useMemory !== 'boolean' || typeof askApproval !== 'boolean' || !Array.isArray(value.tools) || !value.tools.every(name => typeof name === 'string') || typeof value.agent !== 'string' || typeof value.prompt !== 'string' || (chat && typeof value.message !== 'string')) throw new BackendError('Invalid turn settings');
  return { message: chat ? value.message as string : '', useMemory, askApproval, tools: value.tools as string[], agent: value.agent, prompt: value.prompt, ...(typeof value.session_id === 'string' ? { sessionId: value.session_id } : {}) };
}
