import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  clampDevSidebarWidth,
  DEV_SIDEBAR_DEFAULT,
  DEV_SIDEBAR_MAX,
  DEV_SIDEBAR_MIN,
  loadDevPermission,
  loadDevSidebarWidth,
  loadMarkdownOpenMode,
  saveDevPermission,
  saveDevSidebarWidth,
  saveMarkdownOpenMode,
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
