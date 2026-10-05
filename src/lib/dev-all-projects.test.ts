import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildProjectGroups,
  expandCollapsedProject,
  isAppProject,
  isProjectCollapsed,
  isSameProject,
  removeProjectGroup,
  toggleCollapsedProject,
  upsertProjectGroup,
} from "./dev-all-projects.ts";
import type { JourneySummary } from "./dev-journey.ts";
import type { DevConversationSummary } from "./tauri.ts";

function chat(id: string, title = id): DevConversationSummary {
  return {
    id,
    title,
    created_at: "t0",
    updated_at: "t0",
  };
}

function journey(id: string, title = id): JourneySummary {
  return {
    id,
    title,
    created_at: "t0",
    updated_at: "t0",
    sort_order: 0,
    collapsed: false,
  };
}

describe("isSameProject", () => {
  it("treats trailing slashes and case as the same project", () => {
    assert.equal(isSameProject("/app/Demo/", "/app/demo"), true);
    assert.equal(isSameProject("/app/demo", "/app/other"), false);
    assert.equal(isSameProject("", "/app/demo"), false);
  });
});

describe("buildProjectGroups", () => {
  it("keeps recents first, includes empty folders, and attaches loaded chats", () => {
    const groups = buildProjectGroups(
      [
        { name: "demo", path: "/app/projects/demo" },
        { name: "idle", path: "/app/projects/idle" },
      ],
      ["/Users/me/code", "/app/projects/demo/"],
      {
        "/users/me/code": { conversations: [chat("c1", "Notes")], journeys: [] },
        "/app/projects/demo": { conversations: [chat("c2")], journeys: [journey("j1")] },
      },
    );
    assert.deepEqual(
      groups.map((row) => row.path),
      ["/Users/me/code", "/app/projects/demo", "/app/projects/idle"],
    );
    assert.equal(groups[0].conversations[0]?.title, "Notes");
    assert.equal(groups[1].journeys[0]?.id, "j1");
    assert.deepEqual(groups[2].conversations, []);
    assert.deepEqual(groups[2].journeys, []);
  });
});

describe("upsertProjectGroup", () => {
  it("patches an existing group and prepends a missing project", () => {
    const start = buildProjectGroups([{ name: "demo", path: "/app/demo" }], [], {});
    const patched = upsertProjectGroup(start, "/app/demo/", {
      conversations: [chat("c1")],
    });
    assert.equal(patched.length, 1);
    assert.equal(patched[0].conversations[0]?.id, "c1");

    const added = upsertProjectGroup(patched, "/app/other", {
      name: "other",
      conversations: [chat("c2")],
    });
    assert.equal(added[0].path, "/app/other");
    assert.equal(added[0].name, "other");
    assert.equal(added[1].path, "/app/demo");
  });
});

describe("removeProjectGroup", () => {
  it("drops the matching project and keeps the others", () => {
    const groups = buildProjectGroups(
      [
        { name: "demo", path: "/app/projects/demo" },
        { name: "idle", path: "/app/projects/idle" },
      ],
      [],
      {},
    );
    const next = removeProjectGroup(groups, "/app/projects/Demo/");
    assert.deepEqual(
      next.map((row) => row.path),
      ["/app/projects/idle"],
    );
  });
});

describe("isAppProject", () => {
  it("is true only for a direct child of the app projects folder", () => {
    assert.equal(isAppProject("/app/projects/demo", "/app/projects"), true);
    assert.equal(isAppProject("/app/projects/demo/", "/app/Projects"), true);
    assert.equal(isAppProject("/app/projects", "/app/projects"), false);
    assert.equal(isAppProject("/app/projects/demo/src", "/app/projects"), false);
    assert.equal(isAppProject("/Users/me/code", "/app/projects"), false);
    assert.equal(isAppProject("/app/projects/demo", ""), false);
  });
});

describe("collapsed projects", () => {
  it("toggles and expands using normalized keys", () => {
    const on = toggleCollapsedProject([], "/app/Demo/");
    assert.deepEqual(on, ["/app/demo"]);
    assert.equal(isProjectCollapsed(on, "/APP/demo"), true);
    assert.deepEqual(toggleCollapsedProject(on, "/app/demo"), []);
    assert.deepEqual(expandCollapsedProject(["/app/demo", "/app/other"], "/app/Demo/"), [
      "/app/other",
    ]);
  });
});
