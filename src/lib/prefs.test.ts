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
  loadGitChangesView,
  loadMarkdownOpenMode,
  saveDevPermission,
  saveDevSidebarWidth,
  saveGitChangesView,
  saveMarkdownOpenMode,
  setFileHoverCard,
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
