import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectMcp,
  detectWorkspaceMcp,
  mcpAuthNames,
  mcpPillSummary,
  mcpSystemLine,
  parseMcpConfig,
  setMcpEnabledInToml,
  userMcpRel,
  withMcpAuth,
} from "../mcp.ts";

function server(
  name: string,
  source: string,
  transport: "stdio" | "http",
  enabled: boolean,
  extra: { sources?: string[]; authed?: boolean } = {},
) {
  return {
    name,
    source,
    sources: extra.sources ?? [source],
    transport,
    enabled,
    authed: extra.authed ?? false,
  };
}

describe("parseMcpConfig", () => {
  it("reads Claude/Cursor mcpServers and skips env values", () => {
    const servers = parseMcpConfig(
      ".cursor/mcp.json",
      JSON.stringify({
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: { GITHUB_TOKEN: "secret-token" },
          },
          linear: { url: "https://mcp.linear.app/sse" },
        },
      }),
    );
    assert.deepEqual(servers, [
      server("github", ".cursor/mcp.json", "stdio", true),
      server("linear", ".cursor/mcp.json", "http", true),
    ]);
    assert.equal(JSON.stringify(servers).includes("secret-token"), false);
  });

  it("reads VS Code servers and mcp.servers maps", () => {
    assert.deepEqual(
      parseMcpConfig(
        ".vscode/mcp.json",
        JSON.stringify({
          servers: {
            docs: { type: "stdio", command: "uvx", args: ["mcp-docs"] },
          },
        }),
      ),
      [server("docs", ".vscode/mcp.json", "stdio", true)],
    );
    assert.deepEqual(
      parseMcpConfig(
        ".vscode/mcp.json",
        JSON.stringify({
          mcp: {
            servers: {
              remote: { type: "sse", url: "https://example.com/mcp" },
            },
          },
        }),
      ),
      [server("remote", ".vscode/mcp.json", "http", true)],
    );
  });

  it("reads Grok [mcp_servers.name] tables without leaking env", () => {
    const servers = parseMcpConfig(
      ".grok/config.toml",
      `
[mcp_servers.github]
command = "npx"
args = ["-y", "server"]

[mcp_servers.github.env]
GITHUB_TOKEN = "secret-token"

[mcp_servers.remote]
url = "https://mcp.example.com"
`,
    );
    assert.deepEqual(servers, [
      server("github", ".grok/config.toml", "stdio", true),
      server("remote", ".grok/config.toml", "http", true),
    ]);
    assert.equal(JSON.stringify(servers).includes("secret-token"), false);
  });

  it("returns nothing for invalid or empty configs", () => {
    assert.deepEqual(parseMcpConfig(".mcp.json", "{"), []);
    assert.deepEqual(parseMcpConfig(".mcp.json", "{}"), []);
    assert.deepEqual(parseMcpConfig(".mcp.json", JSON.stringify({ mcpServers: { "": { command: "x" } } })), []);
  });

  it("marks Grok servers disabled from the list or enabled = false", () => {
    const servers = parseMcpConfig(
      "~/.grok/config.toml",
      `
disabled_mcp_servers = [
  "github",
]

[mcp_servers.github]
command = "npx"

[mcp_servers.remote]
url = "https://mcp.example.com"
enabled = false

[mcp_servers.ok]
command = "npx"
`,
    );
    assert.deepEqual(
      servers.map((row) => ({ name: row.name, enabled: row.enabled })),
      [
        { name: "github", enabled: false },
        { name: "remote", enabled: false },
        { name: "ok", enabled: true },
      ],
    );
  });
});

describe("detectWorkspaceMcp", () => {
  it("scans known paths and skips missing files", async () => {
    const files: Record<string, string> = {
      ".mcp.json": JSON.stringify({ mcpServers: { railway: { command: "npx" } } }),
      ".cursor/mcp.json": JSON.stringify({ mcpServers: { github: { command: "npx" } } }),
    };
    const servers = await detectWorkspaceMcp(async (path) => files[path] ?? null);
    assert.deepEqual(servers, [
      server("railway", ".mcp.json", "stdio", true),
      server("github", ".cursor/mcp.json", "stdio", true),
    ]);
  });
});

describe("detectMcp", () => {
  it("reads user-home configs even when the workspace has none", async () => {
    const servers = await detectMcp({
      readWorkspace: async () => null,
      readHome: async (path) => {
        if (path === ".cursor/mcp.json") {
          return JSON.stringify({ mcpServers: { railway: { command: "railway" } } });
        }
        if (path === ".grok/config.toml") {
          return `
disabled_mcp_servers = ["linear"]
[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"
`;
        }
        return null;
      },
    });
    assert.deepEqual(servers, [
      server("linear", "~/.grok/config.toml", "http", false),
      server("railway", "~/.cursor/mcp.json", "stdio", true),
    ]);
  });

  it("merges the same server from several files and applies Grok's disabled list", async () => {
    const servers = await detectMcp({
      readHome: async (path) => {
        if (path === ".grok/config.toml") {
          return `disabled_mcp_servers = ["polylane"]\n`;
        }
        if (path === ".cursor/mcp.json") {
          return JSON.stringify({ mcpServers: { polylane: { url: "https://mcp.polylane.com/mcp" } } });
        }
        if (path === ".claude.json") {
          return JSON.stringify({ mcpServers: { polylane: { type: "http", url: "https://mcp.polylane.com/mcp" } } });
        }
        return null;
      },
    });
    assert.deepEqual(servers, [
      server("polylane", "~/.cursor/mcp.json", "http", false, {
        sources: ["~/.cursor/mcp.json", "~/.claude.json"],
      }),
    ]);
  });
});

describe("mcp copy", () => {
  it("summarizes the pill and mentions servers to the agent", () => {
    const servers = [
      server("github", ".cursor/mcp.json", "stdio", true),
      server("railway", ".mcp.json", "stdio", false),
    ];
    assert.equal(mcpPillSummary([]), "");
    assert.equal(mcpPillSummary(servers.slice(0, 1)), "MCP · github");
    assert.equal(mcpPillSummary(servers), "MCP · 1/2");
    assert.equal(mcpSystemLine([]), "");
    const line = mcpSystemLine(servers);
    assert.match(line, /not connected/);
    assert.match(line, /github \(\.cursor\/mcp\.json\)/);
    assert.match(line, /railway \(\.mcp\.json\)/);
    assert.match(line, /cannot call/);
  });
});

describe("setMcpEnabledInToml", () => {
  it("adds and removes a name in disabled_mcp_servers without dropping other keys", () => {
    const start = `disabled_mcp_servers = [
  "notion",
]

[cli]
auto_update = true

[mcp_servers.notion]
url = "https://mcp.notion.com/mcp"
enabled = false
`;
    const on = setMcpEnabledInToml(start, "notion", true);
    assert.match(on, /disabled_mcp_servers = \[\]/);
    assert.match(on, /enabled = true/);
    assert.match(on, /auto_update = true/);
    const off = setMcpEnabledInToml(on, "notion", false);
    assert.match(off, /"notion"/);
    assert.match(off, /enabled = false/);
    const added = setMcpEnabledInToml(start, "railway", false);
    assert.match(added, /"railway"/);
    assert.match(added, /"notion"/);
  });
});

describe("mcp auth helpers", () => {
  it("reads server names from credential keys and never keeps tokens", () => {
    const names = mcpAuthNames({
      "linear:https://mcp.linear.app/mcp": { token_response: { access_token: "secret-token" } },
      "notion:https://mcp.notion.com/mcp": { client_id: "abc" },
    });
    assert.deepEqual(names, ["linear", "notion"]);
    assert.equal(JSON.stringify(names).includes("secret-token"), false);
    const marked = withMcpAuth(
      [server("linear", "~/.grok/config.toml", "http", true), server("railway", "~/.cursor/mcp.json", "stdio", true)],
      names,
    );
    assert.equal(marked[0].authed, true);
    assert.equal(marked[1].authed, false);
    assert.equal(userMcpRel("~/.grok/config.toml"), ".grok/config.toml");
    assert.equal(userMcpRel(".cursor/mcp.json"), null);
  });
});
