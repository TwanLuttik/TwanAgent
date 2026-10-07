import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  clampSidebarWidth,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  loadPermission,
  loadSidebarWidth,
  loadFileHoverCard,
  loadCollapsedProjects,
  loadComposerDrafts,
  loadConversation,
  loadRecentWorkspaces,
  loadWorkspace,
  loadPerfOverlay,
  loadGitChangesView,
  loadMarkdownOpenMode,
  loadOpenFileTree,
  savePermission,
  saveSidebarWidth,
  saveGitChangesView,
  pushRecentWorkspace,
  removeRecentWorkspace,
  rewriteStoredProjectPaths,
  saveCollapsedProjects,
  saveComposerDraft,
  saveConversation,
  saveWorkspace,
  saveMarkdownOpenMode,
  saveOpenFileTree,
  setFileHoverCard,
  setPerfOverlay,
} from "../prefs.ts";

function mockStorage() {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", { value: localStorage, configurable: true });
}

describe("sidebar width", () => {
  beforeEach(() => {
    mockStorage();
  });

  it("clamps to the allowed range", () => {
    assert.equal(clampSidebarWidth(Number.NaN), SIDEBAR_DEFAULT);
    assert.equal(clampSidebarWidth(40), SIDEBAR_MIN);
    assert.equal(clampSidebarWidth(900), SIDEBAR_MAX);
    assert.equal(clampSidebarWidth(240.6), 241);
  });

  it("saves and reloads the sidebar width", () => {
    saveSidebarWidth(280);
    assert.equal(loadSidebarWidth(), 280);
  });

  it("falls back to the default when nothing is stored", () => {
    assert.equal(loadSidebarWidth(), SIDEBAR_DEFAULT);
  });

  it("clamps a stored value that is out of range", () => {
    localStorage.setItem("twanagent.sidebarWidth", "40");
    assert.equal(loadSidebarWidth(), SIDEBAR_MIN);
  });
});

describe("markdown open mode", () => {
  beforeEach(() => {
    mockStorage();
  });

  it("defaults to editor when nothing is stored", () => {
    assert.equal(loadMarkdownOpenMode(), "editor");
  });

  it("saves and reloads the viewer preference", () => {
    saveMarkdownOpenMode("viewer");
    assert.equal(loadMarkdownOpenMode(), "viewer");
  });

  it("treats unknown stored values as editor", () => {
    localStorage.setItem("twanagent.markdownOpen", "split");
    assert.equal(loadMarkdownOpenMode(), "editor");
  });
});

describe("git changes view", () => {
  beforeEach(() => {
    mockStorage();
  });

  it("defaults to list when nothing is stored", () => {
    assert.equal(loadGitChangesView(), "list");
  });

  it("saves and reloads tree mode", () => {
    saveGitChangesView("tree");
    assert.equal(loadGitChangesView(), "tree");
  });

  it("treats unknown stored values as list", () => {
    localStorage.setItem("twanagent.gitChangesView", "grid");
    assert.equal(loadGitChangesView(), "list");
  });
});

describe("file hover card", () => {
  beforeEach(() => {
    mockStorage();
    Object.defineProperty(globalThis, "document", {
      value: { documentElement: { dataset: {} as Record<string, string> } },
      configurable: true,
    });
  });

  it("defaults to on when nothing is stored", () => {
    assert.equal(loadFileHoverCard(), true);
  });

  it("saves and reloads the preference", () => {
    setFileHoverCard(false);
    assert.equal(loadFileHoverCard(), false);
    setFileHoverCard(true);
    assert.equal(loadFileHoverCard(), true);
  });

  it("treats off/false/0 as disabled", () => {
    localStorage.setItem("twanagent.fileHoverCard", "off");
    assert.equal(loadFileHoverCard(), false);
    localStorage.setItem("twanagent.fileHoverCard", "false");
    assert.equal(loadFileHoverCard(), false);
    localStorage.setItem("twanagent.fileHoverCard", "0");
    assert.equal(loadFileHoverCard(), false);
  });
});

describe("project path migration", () => {
  beforeEach(() => {
    mockStorage();
  });

  it("rewrites the open project, recents, chats, and collapsed keys", () => {
    saveWorkspace("/App/projects/Demo/");
    pushRecentWorkspace("/App/projects/Demo");
    pushRecentWorkspace("/Users/me/code");
    saveConversation("/app/projects/demo", "chat-1");
    saveCollapsedProjects(["/app/projects/demo"]);
    rewriteStoredProjectPaths([
      { from: "/app/projects/Demo", to: "/Users/me/twanagent/projects/Demo" },
    ]);
    assert.equal(loadWorkspace(), "/Users/me/twanagent/projects/Demo");
    assert.deepEqual(loadRecentWorkspaces(), [
      "/Users/me/code",
      "/Users/me/twanagent/projects/Demo",
    ]);
    assert.equal(loadConversation("/Users/me/twanagent/projects/Demo"), "chat-1");
    assert.equal(loadConversation("/app/projects/demo"), "");
    assert.deepEqual(loadCollapsedProjects(), ["/users/me/twanagent/projects/demo"]);
  });
});

describe("recent workspaces", () => {
  beforeEach(() => {
    mockStorage();
  });

  it("removes a recent by normalized path", () => {
    pushRecentWorkspace("/app/demo");
    pushRecentWorkspace("/app/other");
    assert.deepEqual(removeRecentWorkspace("/app/Demo/"), ["/app/other"]);
    assert.deepEqual(loadRecentWorkspaces(), ["/app/other"]);
  });
});

describe("all projects sidebar", () => {
  beforeEach(() => {
    mockStorage();
  });

  it("saves collapsed project keys", () => {
    assert.deepEqual(loadCollapsedProjects(), []);
    saveCollapsedProjects(["/app/demo", "/app/other"]);
    assert.deepEqual(loadCollapsedProjects(), ["/app/demo", "/app/other"]);
  });
});

describe("composer drafts", () => {
  beforeEach(() => {
    mockStorage();
  });

  it("keeps each conversation's prompt after a reload", () => {
    saveComposerDraft("chat-a", "finish the sidebar");
    saveComposerDraft("chat-b", "check the terminal");
    assert.deepEqual(loadComposerDrafts(), {
      "chat-a": "finish the sidebar",
      "chat-b": "check the terminal",
    });
    saveComposerDraft("chat-a", "");
    assert.deepEqual(loadComposerDrafts(), { "chat-b": "check the terminal" });
  });
});

describe("open file tree", () => {
  beforeEach(() => {
    mockStorage();
  });

  it("keeps opened folders for a project across a reload", () => {
    assert.deepEqual(loadOpenFileTree("/app/demo"), []);
    saveOpenFileTree("/app/demo/", ["src", "src/components"]);
    assert.deepEqual(loadOpenFileTree("/app/Demo"), ["src", "src/components"]);
    assert.deepEqual(loadOpenFileTree("/app/other"), []);
  });

  it("drops a project when every folder is closed", () => {
    saveOpenFileTree("/app/demo", ["src"]);
    saveOpenFileTree("/app/demo", []);
    assert.deepEqual(loadOpenFileTree("/app/demo"), []);
  });
});

describe("performance overlay", () => {
  beforeEach(() => {
    mockStorage();
  });

  it("defaults to off when nothing is stored", () => {
    assert.equal(loadPerfOverlay(), false);
  });

  it("saves and reloads the preference", () => {
    setPerfOverlay(true);
    assert.equal(loadPerfOverlay(), true);
    setPerfOverlay(false);
    assert.equal(loadPerfOverlay(), false);
  });
});

describe("permission mode", () => {
  beforeEach(() => {
    mockStorage();
  });

  it("saves and reloads the permission mode", () => {
    savePermission("approve-all");
    assert.equal(loadPermission(), "approve-all");
  });

  it("falls back to empty when nothing is stored", () => {
    assert.equal(loadPermission(), "");
  });
});
