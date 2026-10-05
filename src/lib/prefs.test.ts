import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  clampDevSidebarWidth,
  DEV_SIDEBAR_DEFAULT,
  DEV_SIDEBAR_MAX,
  DEV_SIDEBAR_MIN,
  loadDevPermission,
  loadDevSidebarWidth,
  loadFileHoverCard,
  loadAllProjects,
  loadCollapsedProjects,
  loadComposerDrafts,
  loadDevConversation,
  loadDevRecentWorkspaces,
  loadDevWorkspace,
  loadPerfOverlay,
  loadGitChangesView,
  loadMarkdownOpenMode,
  loadOpenFileTree,
  saveDevPermission,
  saveDevSidebarWidth,
  saveGitChangesView,
  pushDevRecentWorkspace,
  removeDevRecentWorkspace,
  rewriteStoredProjectPaths,
  saveCollapsedProjects,
  saveComposerDraft,
  saveDevConversation,
  saveDevWorkspace,
  saveMarkdownOpenMode,
  saveOpenFileTree,
  setAllProjects,
  setFileHoverCard,
  setPerfOverlay,
} from "./prefs.ts";

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
    assert.equal(clampDevSidebarWidth(Number.NaN), DEV_SIDEBAR_DEFAULT);
    assert.equal(clampDevSidebarWidth(40), DEV_SIDEBAR_MIN);
    assert.equal(clampDevSidebarWidth(900), DEV_SIDEBAR_MAX);
    assert.equal(clampDevSidebarWidth(240.6), 241);
  });

  it("saves and reloads the sidebar width", () => {
    saveDevSidebarWidth(280);
    assert.equal(loadDevSidebarWidth(), 280);
  });

  it("falls back to the default when nothing is stored", () => {
    assert.equal(loadDevSidebarWidth(), DEV_SIDEBAR_DEFAULT);
  });

  it("clamps a stored value that is out of range", () => {
    localStorage.setItem("twanagent.sidebarWidth", "40");
    assert.equal(loadDevSidebarWidth(), DEV_SIDEBAR_MIN);
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
    saveDevWorkspace("/App/projects/Demo/");
    pushDevRecentWorkspace("/App/projects/Demo");
    pushDevRecentWorkspace("/Users/me/code");
    saveDevConversation("/app/projects/demo", "chat-1");
    saveCollapsedProjects(["/app/projects/demo"]);
    rewriteStoredProjectPaths([
      { from: "/app/projects/Demo", to: "/Users/me/twanagent/projects/Demo" },
    ]);
    assert.equal(loadDevWorkspace(), "/Users/me/twanagent/projects/Demo");
    assert.deepEqual(loadDevRecentWorkspaces(), [
      "/Users/me/code",
      "/Users/me/twanagent/projects/Demo",
    ]);
    assert.equal(loadDevConversation("/Users/me/twanagent/projects/Demo"), "chat-1");
    assert.equal(loadDevConversation("/app/projects/demo"), "");
    assert.deepEqual(loadCollapsedProjects(), ["/users/me/twanagent/projects/demo"]);
  });
});

describe("recent workspaces", () => {
  beforeEach(() => {
    mockStorage();
  });

  it("removes a recent by normalized path", () => {
    pushDevRecentWorkspace("/app/demo");
    pushDevRecentWorkspace("/app/other");
    assert.deepEqual(removeDevRecentWorkspace("/app/Demo/"), ["/app/other"]);
    assert.deepEqual(loadDevRecentWorkspaces(), ["/app/other"]);
  });
});

describe("all projects sidebar", () => {
  beforeEach(() => {
    mockStorage();
  });

  it("defaults to off when nothing is stored", () => {
    assert.equal(loadAllProjects(), false);
  });

  it("saves and reloads the preference", () => {
    setAllProjects(true);
    assert.equal(loadAllProjects(), true);
    setAllProjects(false);
    assert.equal(loadAllProjects(), false);
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
    saveDevPermission("approve-all");
    assert.equal(loadDevPermission(), "approve-all");
  });

  it("falls back to empty when nothing is stored", () => {
    assert.equal(loadDevPermission(), "");
  });
});
