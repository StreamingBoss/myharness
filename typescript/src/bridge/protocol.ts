import { DiagnosticError } from '../failure.js';
import type { Project } from '../browser/workspace.js';
export const BRIDGE_CONNECTION_TIMEOUT_MS = 120_000;
export interface BridgeGrants { writes: boolean; commands: boolean; gitWrites: boolean }
export interface BridgeSnapshot { project: Project; workspace?: string; git: boolean; grants: BridgeGrants; tokenization?: { models: string[]; ollamaUrl: string; automatic?: boolean } }
export interface BridgeRequest { id: string; operation: string; args: Record<string, unknown> }
export class BridgeError extends DiagnosticError {
  constructor(message: string, readonly status = 400, timeoutMs?: number) { super({ source: 'bridge', component: 'Local workspace bridge', reason: message, recovery: 'Check the bridge process, pairing and granted permissions in Guide & Setup. Pair again if its connection expired.', ...(timeoutMs === undefined ? {} : { timeoutMs }) }); }
}
export function text(args: Record<string, unknown>, key: string): string {
  if (typeof args[key] !== 'string') throw new BridgeError(`${key} must be a string`);
  return args[key];
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('Expected an object');
  return value as Record<string, unknown>;
}
