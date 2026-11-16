import { DiagnosticError } from './failure.js';

/** Shared by the tokenizer helper (Node) and its browser client. The helper tokenizes text and nothing else. */
export const HELPER_DEFAULT_PORT = 5002;
export const HELPER_DEFAULT_ENDPOINT = `http://127.0.0.1:${HELPER_DEFAULT_PORT}`;
export const HELPER_DEFAULT_ORIGIN = 'https://harnessarium.com';
export const HELPER_REQUEST_TIMEOUT_MS = 120_000;
/** Covers the helper's own startup (30 s), Ollama rendering (180 s) and tokenization (30 s) limits. */
export const HELPER_INSPECTION_TIMEOUT_MS = 260_000;
/** What a connected helper can do. `automatic`: it finds the model file itself; `models`: operator-configured tokenizers. */
export interface HelperInfo { ollamaUrl: string; models: string[]; automatic: boolean }
export interface HelperRequest { id: string; operation: string; args: Record<string, unknown> }
export class HelperError extends DiagnosticError {
  constructor(message: string, readonly status = 400, timeoutMs?: number) {
    super({ source: 'helper', component: 'Tokenizer helper', reason: message, recovery: 'Check that the tokenizer helper is running on this computer and allows this website, then connect it again in the token viewer.', ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  }
}
export function text(args: Record<string, unknown>, key: string): string {
  if (typeof args[key] !== 'string') throw new HelperError(`${key} must be a string`);
  return args[key];
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HelperError('Expected an object');
  return value as Record<string, unknown>;
}
