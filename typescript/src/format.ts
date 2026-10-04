import type { ChatMessage, ToolDefinition } from './core.js';

export const characters = (text: string): number => [...text].length;
export const sliceCharacters = (text: string, end: number): string => [...text].slice(0, end).join('');
export const lines = (text: string): string[] => text === '' ? [] : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split(/\n|\r/);

/** Python-compatible JSON spacing; this keeps displayed requests and estimates stable. */
export function json(value: unknown, indent?: number): string {
  const encoded = JSON.stringify(value, null, indent);
  if (indent !== undefined) return encoded;
  let result = '', quoted = false, escaped = false;
  for (const char of encoded) {
    result += char;
    if (!quoted && (char === ',' || char === ':')) result += ' ';
    if (char === '"' && !escaped) quoted = !quoted;
    escaped = char === '\\' && !escaped;
  }
  return result;
}

export function pythonRepr(value: unknown): string {
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string') {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    return quote + value.replace(/\\/g, '\\\\').replaceAll(quote, '\\' + quote).replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + quote;
  }
  if (Array.isArray(value)) return '[' + value.map(pythonRepr).join(', ') + ']';
  if (typeof value === 'object') return '{' + Object.entries(value).map(([key, item]) => pythonRepr(key) + ': ' + pythonRepr(item)).join(', ') + '}';
  return String(value);
}

export function splitJson(shown: unknown, highlighted: unknown): string[] {
  const encoded = json(shown, 2);
  const marker = '"@@HIGHLIGHT@@"';
  const position = encoded.indexOf(marker);
  const before = encoded.slice(0, position);
  const after = encoded.slice(position + marker.length);
  const lastLine = before.slice(before.lastIndexOf('\n') + 1);
  const indentation = lastLine.match(/^\s*/)! [0];
  return [before, json(highlighted, 2).replaceAll('\n', '\n' + indentation), after];
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, ordered(item)]));
  return value;
}

export function toolAsGoValue(tool: ToolDefinition): string {
  const f = tool.function;
  const p = f.parameters as { type: string; required?: string[]; properties: Record<string, Record<string, unknown>> };
  const properties: Record<string, unknown> = {};
  for (const name of Object.keys(p.properties).sort()) {
    const property: Record<string, unknown> = {};
    for (const key of ['anyOf', 'type', 'items', 'description', 'enum', 'properties', 'required']) {
      if (p.properties[name]![key]) property[key] = p.properties[name]![key];
    }
    properties[name] = property;
  }
  const encoded = JSON.stringify(properties).replaceAll('&', '\\u0026').replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
  return `{${f.name} ${f.description} {${p.type} <nil> <nil> [${(p.required ?? []).join(' ')}] ${encoded}}}`;
}

export function renderQwenPrompt(messages: ChatMessage[], tools: ToolDefinition[]): string {
  const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
  const turns = messages.filter(message => message.role !== 'system');
  const lastUser = turns.map(message => message.role).lastIndexOf('user');
  let out = '';
  if (system || tools.length) {
    out = '<|im_start|>system\n';
    if (system) out += '\n' + system;
    if (tools.length) {
      out += '\n\n# Tools\n\nYou may call one or more functions to assist with the user query.\n\nYou are provided with function signatures within <tools></tools> XML tags:\n<tools>';
      for (const tool of tools) out += '\n{"type": "function", "function": ' + toolAsGoValue(tool) + '}';
      out += '\n</tools>\n\nFor each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>';
    }
    out += '<|im_end|>\n';
  }
  for (const [index, message] of turns.entries()) {
    const last = index === turns.length - 1;
    if (message.role === 'user') out += `<|im_start|>user\n${message.content}${index === lastUser ? ' /think' : ''}<|im_end|>\n`;
    else if (message.role === 'assistant') {
      out += '<|im_start|>assistant\n';
      if (message.content) out += message.content;
      else if (message.tool_calls?.length) {
        out += '<tool_call>\n';
        for (const call of message.tool_calls) out += `{"name": "${call.function.name}", "arguments": ${JSON.stringify(ordered(call.function.arguments ?? {}))}}\n`;
        out += '</tool_call>';
      }
      if (!last) out += '<|im_end|>\n';
    } else out += `<|im_start|>user\n<tool_response>\n${message.content}\n</tool_response><|im_end|>\n`;
    if (message.role !== 'assistant' && last) out += '<|im_start|>assistant\n';
  }
  return out;
}

export const estimateTokens = (system: ChatMessage[], conversation: ChatMessage[], tools: ToolDefinition[]): number => Math.ceil(characters(renderQwenPrompt([...system, ...conversation], tools)) / 4);

export function retainedBoundary(conversation: ChatMessage[]): number {
  let boundary = Math.max(0, conversation.length - 4);
  while (boundary > 0 && conversation[boundary]!.role === 'tool') boundary -= 1;
  return boundary;
}
