export type McpTransport = "stdio" | "http";

export type DetectedMcpServer = {
  name: string;
  source: string;
  sources: string[];
  transport: McpTransport;
  enabled: boolean;
  authed: boolean;
};

export const MCP_CONFIG_PATHS = [
  ".mcp.json",
  "mcp.json",
  ".cursor/mcp.json",
  ".vscode/mcp.json",
  ".grok/config.toml",
] as const;

export const HOME_MCP_CONFIG_PATHS = [".grok/config.toml", ".cursor/mcp.json", ".claude.json"] as const;

export function parseMcpConfig(source: string, contents: string): DetectedMcpServer[] {
  if (source.endsWith(".toml")) return parseGrokMcpToml(source, contents);
  return parseMcpJson(source, contents);
}

export async function detectWorkspaceMcp(
  readFile: (path: string) => Promise<string | null>,
): Promise<DetectedMcpServer[]> {
  return readMcpPaths(MCP_CONFIG_PATHS, readFile, (path) => path);
}

export async function detectMcp(opts: {
  readWorkspace?: (path: string) => Promise<string | null>;
  readHome?: (path: string) => Promise<string | null>;
}): Promise<DetectedMcpServer[]> {
  let grokToml: string | null = null;
  const readHome = opts.readHome
    ? async (path: string) => {
        const contents = await opts.readHome!(path);
        if (path === ".grok/config.toml") grokToml = contents;
        return contents;
      }
    : undefined;
  const home = readHome ? await readMcpPaths(HOME_MCP_CONFIG_PATHS, readHome, (path) => `~/${path}`) : [];
  const workspace = opts.readWorkspace ? await detectWorkspaceMcp(opts.readWorkspace) : [];
  return finalizeMcpServers([...home, ...workspace], grokToml);
}

export function finalizeMcpServers(
  servers: DetectedMcpServer[],
  grokToml?: string | null,
): DetectedMcpServer[] {
  const disabled = grokToml ? parseDisabledMcpNames(grokToml) : new Set<string>();
  return mergeMcpServers(servers).map((row) => ({
    ...row,
    enabled: row.enabled && !disabled.has(row.name),
  }));
}

export function mergeMcpServers(servers: DetectedMcpServer[]): DetectedMcpServer[] {
  const order: string[] = [];
  const map = new Map<string, DetectedMcpServer>();
  for (const row of servers) {
    const existing = map.get(row.name);
    if (!existing) {
      order.push(row.name);
      map.set(row.name, { ...row, sources: row.sources.length ? row.sources : [row.source] });
      continue;
    }
    const sources = [...existing.sources];
    for (const source of row.sources.length ? row.sources : [row.source]) {
      if (!sources.includes(source)) sources.push(source);
    }
    map.set(row.name, {
      ...existing,
      sources,
      transport: existing.transport === "http" || row.transport === "http" ? "http" : "stdio",
      enabled: existing.enabled && row.enabled,
      authed: existing.authed || row.authed,
    });
  }
  return order.map((name) => map.get(name)!);
}

export function mcpAuthNames(raw: unknown): string[] {
  if (!isRecord(raw)) return [];
  const names = new Set<string>();
  for (const key of Object.keys(raw)) {
    const name = key.split(":")[0]?.trim();
    if (name) names.add(name);
  }
  return [...names];
}

export function withMcpAuth(servers: DetectedMcpServer[], names: Iterable<string>): DetectedMcpServer[] {
  const authed = new Set(names);
  return servers.map((row) => ({ ...row, authed: authed.has(row.name) }));
}

export function userMcpRel(source: string): string | null {
  if (source.startsWith("~/")) return source.slice(2);
  return null;
}

export function mcpServerNameOk(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(name);
}

export function setMcpEnabledInToml(contents: string, name: string, enabled: boolean): string {
  if (!mcpServerNameOk(name)) return contents;
  let next = rewriteDisabledMcpList(contents, name, enabled);
  return rewriteServerEnabledKey(next, name, enabled);
}

async function readMcpPaths(
  paths: readonly string[],
  readFile: (path: string) => Promise<string | null>,
  sourceOf: (path: string) => string,
): Promise<DetectedMcpServer[]> {
  const out: DetectedMcpServer[] = [];
  for (const path of paths) {
    const contents = await readFile(path);
    if (contents == null) continue;
    out.push(...parseMcpConfig(sourceOf(path), contents));
  }
  return out;
}

export function mcpPillSummary(servers: DetectedMcpServer[]): string {
  if (servers.length === 0) return "";
  const on = servers.filter((row) => row.enabled);
  if (on.length === 1 && on.length === servers.length) return `MCP · ${on[0].name}`;
  return `MCP · ${on.length}/${servers.length}`;
}

export function mcpSystemLine(servers: DetectedMcpServer[]): string {
  if (servers.length === 0) return "";
  const on = servers.filter((row) => row.enabled);
  const off = servers.length - on.length;
  const names = on.map((row) => row.name).join(", ");
  const disabled = off ? ` ${off} disabled.` : "";
  if (on.length === 0) {
    return `MCP servers are configured but disabled.${disabled} They are not called.`;
  }
  return `Enabled MCP servers are connected for this chat. Call their tools by the mcp__server__tool names. Enabled: ${names}.${disabled}`;
}

function parseMcpJson(source: string, contents: string): DetectedMcpServer[] {
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch {
    return [];
  }
  const map = serverMapFrom(raw);
  if (!map) return [];
  const out: DetectedMcpServer[] = [];
  for (const [name, entry] of Object.entries(map)) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    out.push(mcpServer(trimmed, source, transportOf(entry), true));
  }
  return out;
}

function serverMapFrom(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  if (isRecord(raw.mcpServers)) return raw.mcpServers;
  if (isRecord(raw.servers)) return raw.servers;
  if (isRecord(raw.mcp) && isRecord(raw.mcp.servers)) return raw.mcp.servers;
  return null;
}

function transportOf(entry: unknown): McpTransport {
  if (!isRecord(entry)) return "stdio";
  const type = String(entry.type ?? "").toLowerCase();
  if (type === "http" || type === "sse" || type === "streamable-http" || type === "streamable_http") {
    return "http";
  }
  if (typeof entry.url === "string" && entry.url.trim()) return "http";
  return "stdio";
}

function parseGrokMcpToml(source: string, contents: string): DetectedMcpServer[] {
  const disabled = parseDisabledMcpNames(contents);
  const found = new Map<string, { transport: McpTransport; enabled: boolean }>();
  let current: string | null = null;
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    const header = mcpTomlHeader(line);
    if (header) {
      current = header;
      if (!found.has(header)) found.set(header, { transport: "stdio", enabled: !disabled.has(header) });
      continue;
    }
    if (!current) continue;
    const entry = found.get(current);
    if (!entry) continue;
    const key = tomlKey(line);
    if (key === "url") entry.transport = "http";
    else if (key === "command" && entry.transport !== "http") entry.transport = "stdio";
    else if (key === "enabled" && tomlBool(line) === false) entry.enabled = false;
  }
  return [...found].map(([name, row]) => mcpServer(name, source, row.transport, row.enabled));
}

function mcpServer(
  name: string,
  source: string,
  transport: McpTransport,
  enabled: boolean,
): DetectedMcpServer {
  return { name, source, sources: [source], transport, enabled, authed: false };
}

function rewriteDisabledMcpList(contents: string, name: string, enabled: boolean): string {
  const names = [...parseDisabledMcpNames(contents)];
  const has = names.includes(name);
  if (enabled === !has) return contents;
  const next = enabled ? names.filter((row) => row !== name) : [...names, name];
  const block = formatDisabledBlock(next);
  const match = contents.match(/disabled_mcp_servers\s*=\s*\[[\s\S]*?\]/);
  if (match && match.index != null) {
    return contents.slice(0, match.index) + block + contents.slice(match.index + match[0].length);
  }
  if (enabled) return contents;
  const pad = contents.length === 0 || contents.startsWith("\n") ? "" : "\n\n";
  return `${block}${pad}${contents}`;
}

function formatDisabledBlock(names: string[]): string {
  if (names.length === 0) return "disabled_mcp_servers = []";
  return `disabled_mcp_servers = [\n${names.map((name) => `  "${name}"`).join(",\n")}\n]`;
}

function rewriteServerEnabledKey(contents: string, name: string, enabled: boolean): string {
  const header = new RegExp(`\\[mcp_servers\\.${escapeRegExp(name)}\\]`);
  const start = contents.search(header);
  if (start < 0) return contents;
  const rest = contents.slice(start);
  const nextHeader = rest.slice(1).search(/\n\[/);
  const section = nextHeader >= 0 ? rest.slice(0, nextHeader + 1) : rest;
  const tail = nextHeader >= 0 ? rest.slice(nextHeader + 1) : "";
  if (!/(^|\n)enabled\s*=/.test(section)) return contents;
  const updated = section.replace(/(^|\n)enabled\s*=\s*(true|false)/, `$1enabled = ${enabled}`);
  return contents.slice(0, start) + updated + tail;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseDisabledMcpNames(contents: string): Set<string> {
  const names = new Set<string>();
  const block = contents.match(/disabled_mcp_servers\s*=\s*\[([\s\S]*?)\]/);
  if (!block?.[1]) return names;
  for (const match of block[1].matchAll(/"([^"]+)"|'([^']+)'/g)) {
    const name = (match[1] ?? match[2] ?? "").trim();
    if (name) names.add(name);
  }
  return names;
}

function tomlBool(line: string): boolean | null {
  const match = line.match(/=\s*(true|false)\s*$/i);
  if (!match) return null;
  return match[1].toLowerCase() === "true";
}

function mcpTomlHeader(line: string): string | null {
  const quoted = line.match(/^\[mcp_servers\."([^"]+)"(?:\.[^\]]*)?\]$/);
  if (quoted?.[1]?.trim()) return quoted[1].trim();
  const plain = line.match(/^\[mcp_servers\.([^.\]]+)/);
  if (plain?.[1]?.trim()) return plain[1].trim();
  return null;
}

function tomlKey(line: string): string | null {
  const match = line.match(/^([A-Za-z0-9_-]+)\s*=/);
  return match?.[1] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
