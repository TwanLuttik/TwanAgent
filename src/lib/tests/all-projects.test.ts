import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildProjectGroups,
  expandCollapsedProject,
  isAppProject,
  isProjectCollapsed,
  isSameProject,
  projectHasArchived,
  removeProjectGroup,
  patchSidebarConversation,
  patchSidebarConversations,
  moveProjectGroup,
  renameConversationInGroups,
  sameSidebarConversationList,
  sidebarProjects,
  toggleCollapsedProject,
  applyLiveProjectChats,
  isLocalCloudDraft,
  mergeLoadedProjectGroups,
  preferredOpenConversation,
  placeProjectChats,
  sidebarTodoKey,
  stampProjectServer,
  upsertProjectGroup,
  visibleConversations,
  visibleJourneys,
} from "../all-projects.ts";
import type { JourneySummary } from "../journey.ts";
import type { ConversationSummary } from "../tauri.ts";

function chat(id: string, title = id): ConversationSummary {
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

describe("applyLiveProjectChats", () => {
  it("does not copy the open project's chats into another project while they are still loading", () => {
    const groups = buildProjectGroups(
      [
        { name: "alpha", path: "/app/alpha" },
        { name: "beta", path: "/app/beta" },
      ],
      [],
      {
        "/app/alpha": { conversations: [chat("a1", "Alpha chat")], journeys: [] },
        "/app/beta": { conversations: [chat("b1", "Beta chat")], journeys: [] },
      },
    );
    const next = applyLiveProjectChats(
      groups,
      { workspace: "/app/beta", conversations: [chat("a1", "Alpha chat")], journeys: [] },
      "/app/alpha",
    );
    assert.equal(next, groups);
    assert.deepEqual(
      next.map((group) => group.conversations.map((row) => row.id)),
      [["a1"], ["b1"]],
    );
  });

  it("does not paint a local New chat onto a cloud project that already loaded", () => {
    const groups = buildProjectGroups(
      [{ name: "cloud", path: "/mounts/cloud", remote: true }],
      [],
      { "/mounts/cloud": { conversations: [chat("real", "what is the specs of this machine")], journeys: [] } },
    );
    const next = applyLiveProjectChats(
      groups,
      {
        workspace: "/mounts/cloud",
        conversations: [chat("draft", "New chat"), chat("real", "what is the specs of this machine")],
        journeys: [],
      },
      "/mounts/cloud",
    );
    assert.deepEqual(next[0]?.conversations.map((row) => row.id), ["real"]);
  });

  it("updates only the project whose chats have finished loading", () => {
    const groups = buildProjectGroups(
      [
        { name: "alpha", path: "/app/alpha" },
        { name: "beta", path: "/app/beta" },
      ],
      [],
      {
        "/app/alpha": { conversations: [chat("a1", "Alpha chat")], journeys: [] },
        "/app/beta": { conversations: [chat("b1", "Beta chat")], journeys: [] },
      },
    );
    const next = applyLiveProjectChats(
      groups,
      { workspace: "/app/beta", conversations: [chat("b1", "Beta chat"), chat("b2", "New")], journeys: [] },
      "/app/beta",
    );
    assert.deepEqual(
      next.map((group) => group.conversations.map((row) => row.id)),
      [["a1"], ["b1", "b2"]],
    );
  });
});

describe("mergeLoadedProjectGroups", () => {
  it("keeps projects the latest pass has not loaded yet", () => {
    const previous = buildProjectGroups(
      [
        { name: "alpha", path: "/app/alpha" },
        { name: "beta", path: "/app/beta" },
      ],
      [],
      {
        "/app/alpha": { conversations: [chat("a1")], journeys: [] },
        "/app/beta": { conversations: [chat("b1")], journeys: [] },
      },
    );
    const incoming = buildProjectGroups(
      [{ name: "alpha", path: "/app/alpha" }],
      [],
      { "/app/alpha": { conversations: [chat("a1"), chat("a2")], journeys: [] } },
    );
    const next = mergeLoadedProjectGroups(previous, incoming);
    assert.deepEqual(
      next.map((group) => [group.name, group.conversations.map((row) => row.id)]),
      [
        ["alpha", ["a1", "a2"]],
        ["beta", ["b1"]],
      ],
    );
  });

  it("clears a cloud project when its own load comes back empty", () => {
    const previous = buildProjectGroups(
      [{ name: "cloud", path: "/mounts/dev-test-2", remote: true }],
      [],
      {
        "/mounts/dev-test-2": {
          conversations: [chat("real", "what is the specs of this machine"), chat("draft", "New chat")],
          journeys: [journey("j1")],
        },
      },
    );
    const incoming = buildProjectGroups(
      [{ name: "dev-test-2", path: "/mounts/dev-test-2", remote: true }],
      [],
      { "/mounts/dev-test-2": { conversations: [], journeys: [] } },
    );
    const next = mergeLoadedProjectGroups(previous, incoming);
    assert.deepEqual(next[0]?.conversations, []);
    assert.deepEqual(next[0]?.journeys, []);
    assert.equal(next[0]?.remote, true);
    assert.equal(isLocalCloudDraft(chat("draft", "New chat")), true);
    assert.equal(isLocalCloudDraft(chat("real", "what is the specs of this machine")), false);
    assert.equal(isLocalCloudDraft({ ...chat("term", "New chat"), kind: "terminal" }), false);
    const open = preferredOpenConversation(
      [chat("draft", "New chat"), chat("real", "what is the specs of this machine")],
      "draft",
    );
    assert.equal(open?.id, "real");
    assert.equal(preferredOpenConversation([chat("draft", "New chat")], "draft")?.id, "draft");
  });

  it("keeps the server status when a later list pass does not include it", () => {
    const server = {
      machineName: "box",
      host: "box.local",
      user: "me",
      port: 22,
      remotePath: "/srv/cloud",
      online: false,
    };
    const previous = buildProjectGroups(
      [{ name: "cloud", path: "/mounts/cloud", remote: true, server }],
      [],
      { "/mounts/cloud": { conversations: [chat("c1")], journeys: [] } },
    );
    const incoming = buildProjectGroups(
      [{ name: "cloud", path: "/mounts/cloud", remote: true }],
      [],
      { "/mounts/cloud": { conversations: [chat("c1"), chat("c2")], journeys: [] } },
    );
    const next = mergeLoadedProjectGroups(previous, incoming);
    assert.equal(next[0]?.server?.online, false);
    assert.deepEqual(next[0]?.conversations.map((row) => row.id), ["c1", "c2"]);
  });
});

describe("placeProjectChats", () => {
  it("removes a chat from the other project when it belongs to this one", () => {
    const groups = buildProjectGroups(
      [
        { name: "alpha", path: "/app/alpha" },
        { name: "beta", path: "/app/beta" },
      ],
      [],
      {
        "/app/alpha": {
          conversations: [chat("a1", "Alpha"), chat("b-run", "Running in beta")],
          journeys: [],
        },
        "/app/beta": { conversations: [chat("b-run", "Running in beta"), chat("b1", "Beta")], journeys: [] },
      },
    );
    const next = placeProjectChats(groups, "/app/beta", [chat("b-run", "Running in beta"), chat("b1", "Beta")], []);
    assert.deepEqual(
      next.map((group) => group.conversations.map((row) => row.id)),
      [["a1"], ["b-run", "b1"]],
    );
  });

  it("drops a local New chat when placing chats on a cloud project", () => {
    const groups = buildProjectGroups(
      [{ name: "cloud", path: "/mounts/cloud", remote: true }],
      [],
      { "/mounts/cloud": { conversations: [chat("real", "what is the specs of this machine")], journeys: [] } },
    );
    const next = placeProjectChats(
      groups,
      "/mounts/cloud",
      [chat("draft", "New chat"), chat("real", "what is the specs of this machine")],
      [],
      "/mounts/cloud",
    );
    assert.deepEqual(next[0]?.conversations.map((row) => row.id), ["real"]);
  });

  it("keeps the previous project's chats until the project you opened has loaded", () => {
    const groups = buildProjectGroups(
      [
        { name: "alpha", path: "/app/alpha" },
        { name: "beta", path: "/app/beta" },
      ],
      [],
      {
        "/app/alpha": { conversations: [chat("a1", "Alpha chat")], journeys: [] },
        "/app/beta": { conversations: [chat("b1", "Beta chat")], journeys: [] },
      },
    );
    const waiting = placeProjectChats(groups, "/app/beta", [], [], "/app/alpha");
    assert.equal(waiting, groups);
    const loaded = placeProjectChats(groups, "/app/beta", [], [], "/app/beta");
    assert.deepEqual(loaded[1]?.conversations, []);
  });

});

describe("stampProjectServer", () => {
  const server = {
    machineName: "box",
    host: "box.local",
    user: "me",
    port: 22,
    remotePath: "/srv/cloud",
    online: true,
  };

  it("does not give a local project the cloud icon from the project that was just left", () => {
    const groups = buildProjectGroups(
      [
        { name: "cloud", path: "/mounts/cloud", remote: true, server },
        { name: "local", path: "/app/local" },
      ],
      [],
      {},
    );
    const waiting = stampProjectServer(groups, "/app/local", server, "");
    assert.equal(waiting, groups);
    assert.equal(waiting[1]?.remote, undefined);
    assert.equal(waiting[1]?.server, undefined);

    const local = stampProjectServer(groups, "/app/local", null, "/app/local");
    assert.equal(local[0]?.remote, true);
    assert.equal(local[1]?.remote, false);
    assert.notEqual(local[1], groups[1]);
    assert.equal(local[1]?.server, undefined);
    assert.equal(stampProjectServer(local, "/app/local", null, "/app/local"), local);
  });

  it("puts the cloud icon only on the project the lookup finished for", () => {
    const groups = buildProjectGroups(
      [
        { name: "cloud", path: "/mounts/cloud" },
        { name: "local", path: "/app/local" },
      ],
      [],
      {},
    );
    const next = stampProjectServer(groups, "/mounts/cloud", server, "/mounts/cloud");
    assert.equal(next[0]?.remote, true);
    assert.equal(next[0]?.server?.machineName, "box");
    assert.equal(next[1]?.remote, undefined);
    assert.equal(sidebarTodoKey("/App/Local/", "chat-1"), "/app/local\tchat-1");
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

describe("patchSidebarConversations", () => {
  const now = Date.parse("2026-09-16T12:00:30.000Z");

  it("keeps the row when another save stays inside the same age label", () => {
    const rows = [{ ...chat("a1", "Fix the login"), updated_at: "2026-09-16T12:00:10.000Z" }];
    const next = [{ ...rows[0], updated_at: "2026-09-16T12:00:20.000Z" }];
    assert.equal(patchSidebarConversations(rows, next, now), rows);
    assert.equal(patchSidebarConversation(rows[0], next[0], now), rows[0]);
    assert.equal(sameSidebarConversationList(rows, rows), true);
    assert.equal(sameSidebarConversationList(rows, next), false);
  });

  it("replaces the row when the age label or title changes", () => {
    const rows = [{ ...chat("a1", "Fix the login"), updated_at: "2026-09-16T11:58:00.000Z" }];
    const aged = patchSidebarConversations(rows, [{ ...rows[0], updated_at: "2026-09-16T12:00:20.000Z" }], now);
    assert.equal(aged[0]?.updated_at, "2026-09-16T12:00:20.000Z");
    const titled = patchSidebarConversations(rows, [{ ...rows[0], title: "Ship it" }], now);
    assert.equal(titled[0]?.title, "Ship it");
  });

  it("replaces the row when the title changes", () => {
    const rows = [chat("a1", "New chat")];
    const patched = patchSidebarConversations(rows, [{ ...rows[0], title: "Fix the login", updated_at: "t1" }]);
    assert.equal(patched[0]?.title, "Fix the login");
    assert.notEqual(patched, rows);
  });
});

describe("renameConversationInGroups", () => {
  it("renames the chat in its own project and does not copy it into another", () => {
    const groups = buildProjectGroups(
      [
        { name: "alpha", path: "/app/alpha" },
        { name: "beta", path: "/app/beta" },
      ],
      [],
      {
        "/app/alpha": { conversations: [chat("a1", "New chat")], journeys: [] },
        "/app/beta": { conversations: [chat("b1", "Beta")], journeys: [] },
      },
    );
    const renamed = renameConversationInGroups(groups, "a1", { title: "Fix the login" });
    assert.equal(renamed.found, true);
    assert.equal(renamed.groups[0].conversations[0]?.title, "Fix the login");
    assert.deepEqual(
      renamed.groups[1].conversations.map((row) => row.id),
      ["b1"],
    );
    const missing = renameConversationInGroups(groups, "nope", { title: "x" });
    assert.equal(missing.found, false);
    assert.equal(missing.groups, groups);
  });
});

describe("moveProjectGroup", () => {
  it("moves a project in front of another and ignores a missing path", () => {
    const groups = buildProjectGroups(
      [
        { name: "alpha", path: "/app/alpha" },
        { name: "beta", path: "/app/beta" },
        { name: "gamma", path: "/app/gamma" },
      ],
      [],
      {},
    );
    const next = moveProjectGroup(groups, "/app/gamma/", "/app/alpha");
    assert.deepEqual(
      next.map((row) => row.name),
      ["gamma", "alpha", "beta"],
    );
    assert.equal(moveProjectGroup(groups, "/app/alpha", "/missing"), groups);
    assert.equal(moveProjectGroup(groups, "/app/alpha", "/app/alpha"), groups);
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

describe("sidebarProjects", () => {
  it("keeps saved projects, including folders outside the default directory, and drops duplicate paths", () => {
    const rows = sidebarProjects(
      [
        { name: "demo", path: "/Users/me/twanagent-dev/projects/demo" },
        { name: "release", path: "/Users/me/twanagent/projects/release" },
        { name: "outside", path: "/Users/me/code/outside" },
        { name: "again", path: "/Users/me/twanagent-dev/projects/Demo" },
      ],
      "/Users/me/twanagent-dev/projects",
    );
    assert.deepEqual(
      rows.map((row) => row.name),
      ["demo", "release", "outside"],
    );
    assert.deepEqual(sidebarProjects([], ""), []);
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

describe("archived conversations", () => {
  it("hides archived chats until the archive is open, and only then keeps journeys that still have one", () => {
    const rows = [
      chat("live"),
      { ...chat("old"), archived: true, journey_id: "j1" },
      { ...chat("gone"), archived: true },
    ];
    const journeys = [journey("j1"), journey("empty")];
    assert.deepEqual(
      visibleConversations(rows, false).map((row) => row.id),
      ["live"],
    );
    assert.deepEqual(visibleJourneys(journeys, rows, false).map((row) => row.id), ["j1", "empty"]);
    assert.deepEqual(
      visibleConversations(rows, true).map((row) => row.id),
      ["old", "gone"],
    );
    assert.deepEqual(visibleJourneys(journeys, rows, true).map((row) => row.id), ["j1"]);
    assert.equal(projectHasArchived(rows), true);
    assert.equal(projectHasArchived([chat("live")]), false);
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
