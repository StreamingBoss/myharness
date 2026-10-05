import { characters, sliceCharacters } from '../format.js';

/** MCP wire constants and pure helpers. No runtime, transport or UI APIs. */
export const MODERN_VERSIONS = ['2026-07-28'];
/** Handshake-based revisions, newest first. 2024-11-05 is the HTTP+SSE era. */
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const CLIENT_INFO = { name: 'myharness', version: '1.0.0' };
export const META = {
  version: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  capabilities: 'io.modelcontextprotocol/clientCapabilities',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
} as const;
export const ERROR = { headerMismatch: -32020, missingCapability: -32021, unsupportedVersion: -32022, methodNotFound: -32601 } as const;
export const MAX_RESULT_CHARS = 10_000;

export type JsonObject = Record<string, unknown>;
export interface RpcError { code: number; message: string; data?: unknown }
export interface RpcRequest { jsonrpc: '2.0'; id: number | string; method: string; params?: JsonObject }
export interface RpcNotification { jsonrpc: '2.0'; method: string; params?: JsonObject }
export interface RpcResponse { jsonrpc: '2.0'; id: number | string | null; result?: JsonObject; error?: RpcError }

/** A JSON-RPC error returned by the server. */
export class McpError extends Error {
  constructor(readonly error: RpcError) { super(`${error.message} (code ${error.code})`); }
}
/** An HTTP failure without a JSON-RPC error body. */
export class HttpStatusError extends Error {
  constructor(readonly status: number, readonly body: string) { super(`HTTP ${status}${body ? `: ${sliceCharacters(body.trim(), 200)}` : ''}`); }
}

export const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Codes in the range the 2026-07-28 specification reserves; they identify a modern server. */
export function isModernError(error: RpcError | undefined): boolean {
  return error !== undefined && error.code <= -32020 && error.code >= -32099;
}

export function isResponse(value: unknown): value is RpcResponse {
  return isObject(value) && value.jsonrpc === '2.0' && 'id' in value && ('result' in value || 'error' in value) && !('method' in value);
}
export function isRequest(value: unknown): value is RpcRequest {
  return isObject(value) && typeof value.method === 'string' && 'id' in value && value.id !== null;
}

/** Per-request metadata that replaces the initialize handshake in modern revisions. */
export function requestMeta(version: string): JsonObject {
  return { [META.version]: version, [META.clientInfo]: CLIENT_INFO, [META.capabilities]: {} };
}

/** Header value encoding from the Streamable HTTP binding: plain ASCII or a Base64 sentinel. */
export function headerValue(value: string): string {
  const plain = /^[\x20-\x7E\t]*$/.test(value) && value === value.trim() && !(value.startsWith('=?base64?') && value.endsWith('?='));
  if (plain) return value;
  const bytes = new TextEncoder().encode(value);
  return `=?base64?${btoa(String.fromCharCode(...bytes))}?=`;
}

export interface HeaderAnnotation { path: string[]; name: string }
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Validates `x-mcp-header` annotations. Returns the annotated paths or the reason the tool is invalid. */
export function headerAnnotations(schema: unknown): HeaderAnnotation[] | string {
  const found: HeaderAnnotation[] = [];
  let problem = '';
  const visit = (node: unknown, path: string[] | null): void => {
    if (Array.isArray(node)) { for (const item of node) visit(item, null); return; }
    if (!isObject(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'x-mcp-header') {
        if (!path?.length) problem ||= 'x-mcp-header must be on a property reached only through properties';
        else if (typeof value !== 'string' || !TOKEN.test(value)) problem ||= `x-mcp-header on '${path.join('.')}' is not a valid header name`;
        else if (!['string', 'integer', 'boolean'].includes(node.type as string)) problem ||= `x-mcp-header on '${path.join('.')}' needs a string, integer or boolean property`;
        else found.push({ path, name: value });
      } else if (key === 'properties' && path && isObject(value)) {
        for (const [name, child] of Object.entries(value)) visit(child, [...path, name]);
      } else visit(value, null);
    }
  };
  visit(schema, []);
  const names = found.map(item => item.name.toLowerCase());
  if (!problem && new Set(names).size !== names.length) problem = 'x-mcp-header names must be unique';
  return problem || found;
}

/** Mcp-Param-* headers for a tools/call over Streamable HTTP. */
export function mirroredHeaders(annotations: HeaderAnnotation[], args: JsonObject): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const { path, name } of annotations) {
    let value: unknown = args;
    for (const key of path) value = isObject(value) ? value[key] : undefined;
    if (value === undefined || value === null) continue;
    headers[`Mcp-Param-${name}`] = headerValue(String(value));
  }
  return headers;
}

export function limitText(text: string, max = MAX_RESULT_CHARS): string {
  const total = characters(text);
  return total > max ? `${sliceCharacters(text, max)}\n[output truncated: ${total} characters in total]` : text;
}

const bytes = (base64: unknown): number => Math.floor(String(base64 ?? '').length * 3 / 4);

/** Converts MCP content blocks to text the model can read. Binary data is described, not sent. */
export function contentText(blocks: unknown[]): string[] {
  return blocks.map(raw => {
    const block = isObject(raw) ? raw : {};
    switch (block.type) {
      case 'text': return String(block.text ?? '');
      case 'image': case 'audio': return `[${block.type}: ${String(block.mimeType ?? 'unknown type')}, ${bytes(block.data)} bytes omitted]`;
      case 'resource_link': return `[resource link: ${String(block.uri)}${block.name ? ` (${String(block.name)})` : ''}${block.description ? ` — ${String(block.description)}` : ''}]`;
      case 'resource': return resourceContents([block.resource]);
      default: return `[unsupported content type: ${String(block.type)}]`;
    }
  });
}

function resourceContents(items: unknown[]): string {
  return items.map(raw => {
    const item = isObject(raw) ? raw : {};
    const body = typeof item.text === 'string' ? item.text : `[binary content: ${String(item.mimeType ?? 'unknown type')}, ${bytes(item.blob)} bytes omitted]`;
    return `[resource ${String(item.uri)}]\n${body}`;
  }).join('\n\n');
}

/** Model-facing text for a tools/call result. */
export function toolResultText(result: JsonObject): string {
  let parts = contentText(Array.isArray(result.content) ? result.content : []);
  if (!parts.length && result.structuredContent !== undefined) parts = [JSON.stringify(result.structuredContent)];
  const text = parts.join('\n') || '(no content)';
  return limitText(result.isError === true ? `error: ${text}` : text);
}

/** Model-facing text for a resources/read result. */
export function resourceText(result: JsonObject): string {
  return limitText(resourceContents(Array.isArray(result.contents) ? result.contents : []) || '(empty resource)');
}
