import type { McpFetch } from './http.js';
import { isObject, type JsonObject } from './protocol.js';

/** Registries share one entry format. Both list servers; their tools are known only after connecting. */
export type RegistrySource = 'github' | 'official';
export const REGISTRY_SOURCES: Record<RegistrySource, { url: string; path: string; latestOnly: boolean }> = {
  /** GitHub's MCP registry, the one VS Code uses: curated, one entry per server, most-starred first. */
  github: { url: 'https://api.mcp.github.com', path: '/v0.1/servers', latestOnly: false },
  /** The official MCP Registry; every version is listed unless the latest are requested. */
  official: { url: 'https://registry.modelcontextprotocol.io', path: '/v0/servers', latestOnly: true },
};

/** One way to run a registry server, with a ready-to-paste mcp.json entry. */
export interface RegistryOption {
  kind: 'remote' | 'package';
  label: string;
  /** A remote server that can be connected to as-is, for a tool preview. */
  preview: { type: 'http' | 'sse'; url: string } | null;
  config: JsonObject | null;
  notes: string[];
}
export interface RegistryServer { name: string; title: string; description: string; version: string; status: string; website: string; repository: string; options: RegistryOption[] }

const text = (value: unknown): string => typeof value === 'string' ? value : '';
/** A description inside a note, without its own final period. */
const about = (value: unknown): string => text(value).trim().replace(/\.+$/, '');
const envName = (name: string): string => name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
const RUNNERS: Record<string, { command: string; prefix: string[]; spec: (id: string, version: string) => string }> = {
  npm: { command: 'npx', prefix: ['-y'], spec: (id, version) => `${id}@${version}` },
  pypi: { command: 'uvx', prefix: [], spec: (id, version) => `${id}==${version}` },
  oci: { command: 'docker', prefix: ['run', '-i', '--rm'], spec: (id, version) => id.includes(':') || !version ? id : `${id}:${version}` },
  nuget: { command: 'dnx', prefix: [], spec: (id, version) => `${id}@${version}` },
};

/** A key for mcpServers derived from the registry name, e.g. io.github.acme/weather -> weather. */
export function serverKey(name: string): string {
  return name.split('/').pop()!.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32) || 'server';
}

/** `{name}` placeholders in registry templates become `${NAME}` (from the environment) or a default. */
function fill(template: string, variables: unknown, notes: string[]): string {
  return template.replace(/\{([A-Za-z0-9_-]+)\}/g, (_match, name: string) => {
    const variable = isObject(variables) && isObject(variables[name]) ? variables[name] : {};
    if (typeof variable.default === 'string') return variable.default;
    notes.push(`Set ${envName(name)}${variable.description ? `: ${about(variable.description)}` : ''}.`);
    return `\${${envName(name)}}`;
  });
}

function remote(raw: JsonObject, key: string): RegistryOption {
  const notes: string[] = [], type = raw.type === 'sse' ? 'sse' : 'http';
  const url = fill(text(raw.url), raw.variables, notes), headers: Record<string, string> = {};
  for (const header of (Array.isArray(raw.headers) ? raw.headers : []).filter(isObject)) {
    const name = text(header.name);
    if (typeof header.value === 'string') { headers[name] = fill(header.value, header.variables, notes); continue; }
    headers[name] = `\${${envName(name)}}`;
    notes.push(`Set ${envName(name)} for the ${name} header${header.isRequired ? ' (required)' : ''}${header.isSecret ? ', a secret' : ''}${header.description ? `: ${about(header.description)}` : ''}.`);
  }
  const resolved = !url.includes('${');
  if (Object.keys(headers).length) notes.push('The preview can send an Authorization header entered for that preview. Other headers must be supplied through the backend preview API or server configuration.');
  return { kind: 'remote', label: `Remote server · ${type === 'sse' ? 'HTTP+SSE (deprecated)' : 'Streamable HTTP'} · ${url}`, preview: resolved ? { type, url } : null,
    config: { mcpServers: { [key]: { ...(type === 'sse' ? { type } : {}), url, ...(Object.keys(headers).length ? { headers } : {}) } } }, notes };
}

function argumentsOf(items: unknown, notes: string[]): string[] {
  const args: string[] = [];
  for (const arg of (Array.isArray(items) ? items : []).filter(isObject)) {
    const value = typeof arg.value === 'string' ? fill(arg.value, arg.variables, notes) : typeof arg.default === 'string' ? arg.default : undefined;
    if (value === undefined && !arg.isRequired) continue;
    const placeholder = `<${text(arg.valueHint) || text(arg.name).replace(/^-+/, '') || 'value'}>`;
    if (value === undefined) notes.push(`Replace ${placeholder}${arg.description ? `: ${about(arg.description)}` : ''}.`);
    if (arg.type === 'named') args.push(text(arg.name));
    args.push(value ?? placeholder);
  }
  return args;
}

function packaged(raw: JsonObject, key: string): RegistryOption {
  const notes: string[] = [], registry = text(raw.registryType), id = text(raw.identifier), version = text(raw.version);
  const transport = isObject(raw.transport) ? text(raw.transport.type) : 'stdio', runner = RUNNERS[registry];
  const label = `${registry || 'unknown'} package · ${transport} · ${id}${version ? ` ${version}` : ''}`;
  if (transport !== 'stdio') return { kind: 'package', label, preview: null, config: null, notes: ['This package runs its own local HTTP server. Start it as its documentation describes, then add its URL.'] };
  if (!runner) return { kind: 'package', label, preview: null, config: null, notes: [`The harness cannot generate a command for ${registry ? `${registry} packages` : 'this package'}. See the server's documentation.`] };
  const env: Record<string, string> = {}, envFlags: string[] = [];
  for (const variable of (Array.isArray(raw.environmentVariables) ? raw.environmentVariables : []).filter(isObject)) {
    const name = text(variable.name), value = typeof variable.value === 'string' ? fill(variable.value, variable.variables, notes) : typeof variable.default === 'string' ? variable.default : undefined;
    if (value === undefined && !variable.isRequired) { notes.push(`Optional: ${name}${variable.description ? ` (${about(variable.description)})` : ''}.`); continue; }
    env[name] = value ?? `\${${name}}`;
    if (value === undefined) notes.push(`Set ${name}${variable.isSecret ? ', a secret,' : ''} in your environment${variable.description ? `: ${about(variable.description)}` : ''}.`);
    if (registry === 'oci') envFlags.push('-e', name);
  }
  const runtimeArgs = argumentsOf(raw.runtimeArguments, notes);
  // Runtime arguments extend the runner's own (e.g. docker run -i --rm -p …) unless they already start with them.
  const prefix = runtimeArgs[0] === runner.prefix[0] ? [] : runner.prefix;
  const args = [...prefix, ...runtimeArgs, ...envFlags, runner.spec(id, version), ...argumentsOf(raw.packageArguments, notes)];
  const command = text(raw.runtimeHint) || runner.command;
  notes.push(`Adding this runs '${command}', which downloads and starts ${id} with your account's permissions. Registry entries are not reviewed.`);
  return { kind: 'package', label, preview: null, config: { mcpServers: { [key]: { command, args, ...(Object.keys(env).length ? { env } : {}) } } }, notes };
}

/** Normalizes one registry entry into displayable data and configuration options. */
export function registryServer(entry: unknown): RegistryServer | undefined {
  const server = isObject(entry) && isObject(entry.server) ? entry.server : undefined;
  if (!server || typeof server.name !== 'string') return undefined;
  const meta = isObject(entry) && isObject(entry._meta) && isObject(entry._meta['io.modelcontextprotocol.registry/official']) ? entry._meta['io.modelcontextprotocol.registry/official'] : {};
  const key = serverKey(server.name);
  return {
    name: server.name, title: text(server.title) || server.name, description: text(server.description), version: text(server.version),
    status: text(meta.status) || 'active', website: text(server.websiteUrl), repository: isObject(server.repository) ? text(server.repository.url) : '',
    options: [...(Array.isArray(server.remotes) ? server.remotes : []).filter(isObject).map(item => remote(item, key)), ...(Array.isArray(server.packages) ? server.packages : []).filter(isObject).map(item => packaged(item, key))],
  };
}

/** Searches a registry's latest server versions (GitHub's by default). Deleted entries are left out. */
export async function searchRegistry(fetch_: McpFetch, query: { search?: string; cursor?: string; limit?: number; source?: RegistrySource }, signal?: AbortSignal, base?: string): Promise<{ servers: RegistryServer[]; nextCursor: string }> {
  const source = REGISTRY_SOURCES[query.source ?? 'github'];
  const url = new URL(source.path, base ?? source.url);
  if (source.latestOnly) url.searchParams.set('version', 'latest');
  url.searchParams.set('limit', String(query.limit ?? 20));
  if (query.search) url.searchParams.set('search', query.search);
  if (query.cursor) url.searchParams.set('cursor', query.cursor);
  const response = await fetch_(url.href, { method: 'GET', headers: { accept: 'application/json' }, ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error(`the registry answered HTTP ${response.status}`);
  let body: unknown;
  try { body = JSON.parse(await response.text()); } catch { throw new Error('the registry returned invalid JSON'); }
  const data = isObject(body) ? body : {}, metadata = isObject(data.metadata) ? data.metadata : {};
  const servers = (Array.isArray(data.servers) ? data.servers : []).map(registryServer).filter((item): item is RegistryServer => item !== undefined && item.status !== 'deleted');
  return { servers, nextCursor: text(metadata.nextCursor) };
}
