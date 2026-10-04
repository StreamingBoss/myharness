import type { ChatMessage, ModelRequest, ToolCall } from '../core.js';
import type { ModelPort } from '../harness.js';
import { characters, sliceCharacters } from '../format.js';

export const DEMO_MODEL = 'scripted-demo';

/** Predictable teaching examples, explicitly a script rather than an LLM. */
export class DemoModel implements ModelPort {
  async *streamChat(payload: ModelRequest, signal?: AbortSignal): AsyncGenerator<string> {
    if (signal?.aborted) return;
    const userIndex = payload.messages.map(message => message.role).lastIndexOf('user');
    const user = payload.messages[userIndex]!.content;
    const results = payload.messages.slice(userIndex + 1).filter(message => message.role === 'tool');
    const choice = results.length ? { answer: 'The harness returned:\n\n' + results.map(message => message.content).join('\n\n') } : this.choose(user, payload);
    const tokens = Math.ceil(characters(JSON.stringify(payload.messages)) / 4);
    if (choice.call) {
      yield JSON.stringify({ message: { role: 'assistant', content: '', thinking: 'Scripted demo: request a tool and let the harness enforce its policy.', tool_calls: [choice.call] }, done: true, prompt_eval_count: tokens, eval_count: 1 });
      return;
    }
    const content = choice.answer!, halfway = Math.ceil(content.length / 2);
    yield JSON.stringify({ message: { role: 'assistant', content: content.slice(0, halfway) }, done: false });
    await new Promise(resolve => setTimeout(resolve, 10));
    if (signal?.aborted) return;
    yield JSON.stringify({ message: { role: 'assistant', content: content.slice(halfway) }, done: true, prompt_eval_count: tokens, eval_count: Math.ceil(characters(content) / 4) });
  }

  private choose(user: string, payload: ModelRequest): { answer?: string; call?: ToolCall } {
    let name = '', args: Record<string, unknown> = {};
    const text = user.trim();
    if (/^list files$/i.test(text)) name = 'list_files';
    else if (/^read /i.test(text)) { name = 'read_file'; args = { path: text.slice(5).trim() }; }
    else if (/^write [^:]+:/i.test(text)) { name = 'write_file'; const colon = text.indexOf(':'); args = { path: text.slice(6, colon).trim(), content: text.slice(colon + 1).trim() + '\n' }; }
    else if (/^edit [^:]+:.*=>/i.test(text)) { name = 'edit_file'; const colon = text.indexOf(':'), arrow = text.indexOf('=>', colon); args = { path: text.slice(5, colon).trim(), old_text: text.slice(colon + 1, arrow).trim(), new_text: text.slice(arrow + 2).trim() }; }
    else if (/^search /i.test(text)) { name = 'search'; args = { pattern: text.slice(7).trim() }; }
    else if (/^skill /i.test(text)) { name = 'use_skill'; args = { name: text.slice(6).trim() }; }
    else if (/^run /i.test(text)) { name = 'run_command'; args = { command: text.slice(4).trim() }; }
    else if (/^show instructions$/i.test(text)) return { answer: payload.messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n') || 'No system instructions were supplied.' };
    else if (/^what do you remember\??$/i.test(text)) {
      const remembered = payload.messages.slice(0, -1).filter(message => message.role === 'user' && /^remember /i.test(message.content));
      return { answer: remembered.length ? 'Retained in this request:\n' + remembered.map(message => message.content.slice(9)).join('\n') : 'No earlier “remember …” message is present in this request. Compare SENT with memory on and off.' };
    } else if (/^remember /i.test(text)) return { answer: 'Received: ' + text.slice(9) + '. Ask “What do you remember?” and inspect whether the harness sends this message again.' };
    if (name) {
      if (!payload.tools?.some(tool => tool.function.name === name)) return { answer: `${name} is unavailable or disabled. The scripted model only requests tools included in SENT.` };
      return { call: { function: { name, arguments: args } } };
    }
    return { answer: 'This is a scripted learning model, not an LLM. Try: List files; Read README.md; Write note.txt: hello; Edit note.txt: hello => goodbye; Search hello; Skill write-readme; Remember 42; What do you remember?; Show instructions. Connect Ollama for arbitrary questions.' };
  }

  async request(endpoint: string, payload: unknown): Promise<Record<string, unknown>> {
    if (endpoint === 'show') return { template: 'Scripted demo: prepared examples exercise the real harness. There is no LLM inference.', parameters: 'Approximate tokens; context length 4096.' };
    if (endpoint !== 'chat') throw new Error('The demo supports only chat and show');
    const messages = (payload as { messages: ChatMessage[] }).messages;
    return { message: { role: 'assistant', content: 'Earlier conversation: ' + sliceCharacters(messages[1]!.content, 180) }, done: true };
  }
}
