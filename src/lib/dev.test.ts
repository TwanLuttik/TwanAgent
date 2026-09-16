import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  conversationTitleFrom,
  latestAssistantPreview,
  moveById,
  filterProjectRows,
  folderActionEnabled,
  folderActionHint,
  folderName,
  gitChangeForPath,
  gitChangeMap,
  gitFolderHasChanges,
  gitLineStats,
  mergeProjectRows,
  normalizeGitPath,
  pathWithSlash,
  looksLikeGitUrl,
  looksLikePath,
  needsShellConfirm,
  parseToolArgs,
  preferredFolderAction,
  repoNameFromUrl,
  sanitizeProjectName,
  toApiMessages,
  toolSummary,
  transcriptItems,
  liveTranscriptItems,
  systemPrompt,
  withSystem,
  type ChatMessage,
  type GitDecorChange,
} from "./dev.ts";

describe("folderName", () => {
  it("uses the last path segment", () => {
    assert.equal(folderName("/Users/me/project"), "project");
    assert.equal(folderName("C:\\src\\app\\"), "app");
  });
});

describe("project rows", () => {
  it("puts recents first and drops duplicates", () => {
    const rows = mergeProjectRows(
      [
        { name: "demo", path: "/app/projects/demo" },
        { name: "other", path: "/app/projects/other" },
      ],
      ["/Users/me/code", "/app/projects/demo/"],
    );
    assert.deepEqual(
      rows.map((r) => r.path),
      ["/Users/me/code", "/app/projects/demo", "/app/projects/other"],
    );
    assert.equal(rows[0].name, "code");
  });

  it("filters by name or path", () => {
    const rows = [
      { name: "backupanything", path: "/src/backupanything" },
      { name: "notes", path: "/Users/me/notes" },
    ];
    assert.equal(filterProjectRows(rows, "BACK").length, 1);
    assert.equal(filterProjectRows(rows, "users/me").length, 1);
    assert.equal(filterProjectRows(rows, "").length, 2);
  });
});

describe("conversationTitleFrom", () => {
  it("uses the first user message", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "hi" },
      { role: "user", content: "  Fix the login bug  " },
    ];
    assert.equal(conversationTitleFrom(messages), "Fix the login bug");
  });

  it("truncates long titles", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "x".repeat(80) }];
    const title = conversationTitleFrom(messages);
    assert.ok(title.endsWith("…"));
    assert.ok(title.length <= 43);
  });
});

describe("moveById", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("moves an item to another index", () => {
    assert.deepEqual(moveById(rows, "a", "c").map((r) => r.id), ["b", "c", "a"]);
    assert.deepEqual(moveById(rows, "c", "a").map((r) => r.id), ["c", "a", "b"]);
  });

  it("ignores unknown or identical ids", () => {
    assert.equal(moveById(rows, "a", "a"), rows);
    assert.equal(moveById(rows, "missing", "a"), rows);
  });
});

describe("latestAssistantPreview", () => {
  it("prefers the live stream, then the last assistant text", () => {
    assert.equal(
      latestAssistantPreview([{ role: "assistant", content: "older" }], "  New token  "),
      "New token",
    );
    assert.equal(
      latestAssistantPreview([
        { role: "assistant", content: "first" },
        { role: "tool", content: "ok" },
        { role: "assistant", content: "final answer" },
      ]),
      "final answer",
    );
  });

  it("falls back to the latest tool or Working…", () => {
    assert.equal(latestAssistantPreview([{ role: "user", content: "go" }], "", ["Read a.rs"]), "Read a.rs");
    assert.equal(latestAssistantPreview([]), "Working…");
  });
});

describe("parseToolArgs", () => {
  it("parses objects and falls back on junk", () => {
    assert.deepEqual(parseToolArgs('{"path":"a.rs"}'), { path: "a.rs" });
    assert.deepEqual(parseToolArgs("not-json"), {});
  });
});

describe("tool helpers", () => {
  it("labels tools and flags shell confirms", () => {
    assert.equal(needsShellConfirm("run_command"), true);
    assert.equal(needsShellConfirm("read_file"), false);
    assert.equal(toolSummary("run_command", { command: "cargo test" }), "$ cargo test");
    assert.equal(toolSummary("read_file", { path: "src/lib.rs" }), "Read src/lib.rs");
    assert.equal(toolSummary("spawn_subagent", { description: "Find parser" }), "Subagent: Find parser");
  });

  it("hides tool results and groups consecutive tool calls", () => {
    const items = transcriptItems([
      { role: "user", content: "fix the bug" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "1", name: "read_file", arguments: '{"path":"src/lib.rs"}' }],
      },
      { role: "tool", tool_call_id: "1", content: "fn main() {}" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "2", name: "edit_file", arguments: '{"path":"src/lib.rs"}' }],
      },
      { role: "tool", tool_call_id: "2", content: "Edited src/lib.rs" },
      { role: "assistant", content: "Updated the file." },
    ]);
    assert.deepEqual(items, [
      { kind: "user", content: "fix the bug" },
      { kind: "tools", labels: ["Read src/lib.rs", "Edit src/lib.rs"] },
      { kind: "assistant", content: "Updated the file." },
    ]);
  });

  it("keeps committed tool calls above newly streaming text", () => {
    const items = liveTranscriptItems(
      [
        { role: "user", content: "How can we run this in demo mode" },
        {
          role: "assistant",
          content: "I'll check how the app starts.",
          tool_calls: [
            { id: "1", name: "read_file", arguments: '{"path":"telegram_bot.py"}' },
            { id: "2", name: "read_file", arguments: '{"path":"airtable_client.py"}' },
          ],
        },
        { role: "tool", tool_call_id: "1", content: "..." },
        { role: "tool", tool_call_id: "2", content: "..." },
      ],
      "There is **no demo mode** in the repo.",
      ["Read telegram_bot.py", "Read airtable_client.py"],
    );
    assert.deepEqual(
      items.map((item) => item.kind),
      ["user", "assistant", "tools", "assistant"],
    );
    assert.equal(items[1].kind === "assistant" && items[1].content, "I'll check how the app starts.");
    assert.deepEqual(items[2].kind === "tools" ? items[2].labels : [], [
      "Read telegram_bot.py",
      "Read airtable_client.py",
    ]);
    assert.equal(
      items[3].kind === "assistant" && items[3].content,
      "There is **no demo mode** in the repo.",
    );
  });

  it("does not repeat a stream that was just committed", () => {
    const items = liveTranscriptItems(
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "I'll check." },
      ],
      "I'll check.",
    );
    assert.deepEqual(
      items.map((item) => item.kind),
      ["user", "assistant"],
    );
  });

  it("puts in-progress tools after the current stream when nothing is committed yet", () => {
    const items = liveTranscriptItems(
      [{ role: "user", content: "How can we run this in demo mode" }],
      "I'll check how the app starts.",
      ["Read telegram_bot.py"],
    );
    assert.deepEqual(
      items.map((item) => item.kind),
      ["user", "assistant", "tools"],
    );
  });
});

describe("folder command helpers", () => {
  it("detects paths and git URLs", () => {
    assert.equal(looksLikePath("/Users/me/app"), true);
    assert.equal(looksLikePath("~/code"), true);
    assert.equal(looksLikePath("C:\\src\\app"), true);
    assert.equal(looksLikePath("my-app"), false);
    assert.equal(looksLikeGitUrl("https://github.com/acme/app.git"), true);
    assert.equal(looksLikeGitUrl("git@github.com:acme/app.git"), true);
    assert.equal(looksLikeGitUrl("file:///tmp/repo.git"), true);
    assert.equal(looksLikeGitUrl("github.com/acme/app"), false);
    assert.equal(looksLikeGitUrl("https://evil.com/x && rm -rf /"), false);
    assert.equal(looksLikeGitUrl("my-app"), false);
  });

  it("sanitizes project names and repo URLs", () => {
    assert.equal(sanitizeProjectName("My App"), "My-App");
    assert.equal(sanitizeProjectName("  cool_app.v2  "), "cool_app.v2");
    assert.equal(sanitizeProjectName("../etc"), null);
    assert.equal(sanitizeProjectName("foo/bar"), null);
    assert.equal(sanitizeProjectName("."), null);
    assert.equal(repoNameFromUrl("https://github.com/acme/widgets.git"), "widgets");
    assert.equal(repoNameFromUrl("git@github.com:acme/widgets.git"), "widgets");
    assert.equal(repoNameFromUrl("https://github.com/acme/widgets/"), "widgets");
  });

  it("picks the matching action from the query", () => {
    assert.equal(preferredFolderAction(""), "open");
    assert.equal(preferredFolderAction("~/src"), "open");
    assert.equal(preferredFolderAction("demo"), "create");
    assert.equal(preferredFolderAction("https://github.com/acme/app.git"), "clone");
    assert.equal(folderActionEnabled("create", ""), false);
    assert.equal(folderActionEnabled("clone", "demo"), false);
    assert.equal(folderActionEnabled("clone", "https://github.com/acme/app.git"), true);
    assert.equal(folderActionEnabled("open", ""), true);
    assert.match(folderActionHint("create", "demo"), /demo/);
    assert.match(folderActionHint("clone", "https://github.com/acme/app.git"), /app/);
    assert.equal(pathWithSlash("/projects"), "/projects/");
    assert.equal(pathWithSlash("/projects/"), "/projects/");
  });
});

describe("git file decorations", () => {
  const rows: GitDecorChange[] = [
    { path: "src/lib.rs", status: "modified", staged: false, additions: 12, deletions: 3 },
    { path: "README.md", status: "untracked", staged: false, additions: 8, deletions: 0 },
    { path: "apps\\client\\App.tsx", status: "modified", staged: true, additions: 1, deletions: 1 },
  ];

  it("normalizes slashes and looks up a change by path", () => {
    assert.equal(normalizeGitPath("\\src\\lib.rs"), "src/lib.rs");
    const map = gitChangeMap(rows);
    assert.equal(gitChangeForPath(map, "src/lib.rs")?.additions, 12);
    assert.equal(gitChangeForPath(map, "apps/client/App.tsx")?.status, "modified");
    assert.equal(gitChangeForPath(map, "missing.rs"), undefined);
  });

  it("marks folders that contain a changed file", () => {
    const map = gitChangeMap(rows);
    assert.equal(gitFolderHasChanges(map, "src"), true);
    assert.equal(gitFolderHasChanges(map, "apps/client"), true);
    assert.equal(gitFolderHasChanges(map, "apps"), true);
    assert.equal(gitFolderHasChanges(map, "docs"), false);
    assert.equal(gitFolderHasChanges(map, ""), true);
  });

  it("treats missing counts as zero", () => {
    assert.deepEqual(gitLineStats(undefined), { additions: 0, deletions: 0 });
    assert.deepEqual(gitLineStats({ path: "a", status: "modified", staged: false }), {
      additions: 0,
      deletions: 0,
    });
    assert.deepEqual(gitLineStats(rows[0]), { additions: 12, deletions: 3 });
  });
});

describe("toApiMessages", () => {
  it("nests tool calls under function for the chat API", () => {
    const out = toApiMessages([
      { role: "user", content: "fix it" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", name: "read_file", arguments: '{"path":"a.rs"}' }],
      },
      { role: "tool", tool_call_id: "call_1", content: "fn main() {}" },
    ]);
    assert.deepEqual(out[1], {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"a.rs"}' },
        },
      ],
    });
    assert.deepEqual(out[2], {
      role: "tool",
      tool_call_id: "call_1",
      content: "fn main() {}",
    });
  });
});

describe("withSystem", () => {
  it("injects a workspace system prompt and drops old ones", () => {
    const out = withSystem("/tmp/app", [
      { role: "system", content: "old" },
      { role: "user", content: "hi" },
    ]);
    assert.equal(out[0].role, "system");
    assert.match(String(out[0].content), /\/tmp\/app/);
    assert.match(String(out[0].content), /require the user to approve/);
    assert.equal(out.length, 2);
    assert.equal(out[1].role, "user");
  });

  it("describes the selected permission mode", () => {
    assert.match(String(systemPrompt("/tmp/app", "approve-all").content), /without asking/);
    assert.match(String(systemPrompt("/tmp/app", "read-only").content), /Read-only/);
  });
});
