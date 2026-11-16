import { DiagnosticError } from './failure.js';

/**
 * Protocol of the tokenizer helper, a native program (native/tokenizer) that runs next to Ollama.
 * It has two requests, both POST with a JSON body, and tokenizes text and nothing else:
 *   /v1/info      {}                   -> { value: HelperInfo }
 *   /v1/tokenize  { model, content }   -> { value: { identity, tokens: [{ id, bytes }] } }
 * The helper answers only the website origins it was started for; there is no pairing code or token.
 */
export const HELPER_PROTOCOL = 2;
export const HELPER_DEFAULT_PORT = 5002;
export const HELPER_DEFAULT_ENDPOINT = `http://127.0.0.1:${HELPER_DEFAULT_PORT}`;
export const HELPER_DEFAULT_ORIGIN = 'https://harnessarium.com';
/** Where the helper for each system is published. */
export const HELPER_DOWNLOAD_URL = 'https://github.com/StreamingBoss/myharness/releases/latest';
/** Finding the model file can ask Ollama (30 s), and a first use loads the vocabulary. */
export const HELPER_REQUEST_TIMEOUT_MS = 60_000;
/** `ollamaUrl`: the Ollama the helper asks for model files. `models`: models with an operator-chosen file. */
export interface HelperInfo { protocol: number; ollamaUrl: string; models: string[]; automatic: boolean }
export interface HelperTokens { identity: string; tokens: { id: unknown; bytes: unknown }[] }
export class HelperError extends DiagnosticError {
  constructor(message: string, readonly status = 400, timeoutMs?: number) {
    super({ source: 'helper', component: 'Tokenizer helper', reason: message, recovery: 'Check that the tokenizer helper is running on this computer and allows this website, then connect it again in the token viewer.', ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  }
}
