import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProjectGroupRow } from "../all-projects.ts";
import {
  applyProjectMention,
  displayProjectMentions,
  draftProjectMentionSpans,
  expandProjectMentions,
  filterMentionProjects,
  mentionProjectsFor,
  projectMentionAtCursor,
  projectMentionModelText,
  type MentionProject,
} from "../project-mention.ts";

const orca: MentionProject = {
  token: "Orca",
  name: "Orca",
  path: "/Users/twan/orca",
  alias: "",
};
const api: MentionProject = {
  token: "api",
  name: "api",
  path: "/Users/twan/api",
  alias: "api",
};

describe("projectMentionAtCursor", () => {
  it("reads the query after # at the caret", () => {
    assert.deepEqual(projectMentionAtCursor("use #orc", 8), { start: 4, end: 8, query: "orc" });
    assert.deepEqual(projectMentionAtCursor("#", 1), { start: 0, end: 1, query: "" });
    assert.equal(projectMentionAtCursor("see foo#bar", 11), null);
    assert.equal(projectMentionAtCursor("done #Orca ", 11), null);
  });
});

describe("filterMentionProjects", () => {
  it("prefers a name prefix over a later path match", () => {
    const rows = filterMentionProjects(
      [
        { token: "orchestra", name: "orchestra", path: "/src/orca", alias: "" },
        orca,
      ],
      "orc",
    );
    assert.equal(rows[0]?.token, "orchestra");
    assert.equal(rows[1]?.token, "Orca");
    assert.equal(filterMentionProjects([orca], "missing").length, 0);
  });
});

describe("expandProjectMentions", () => {
  it("turns a project mention into the name and folder the model can use", () => {
    assert.equal(
      expandProjectMentions("check #Orca and #notes", [orca]),
      `check ${projectMentionModelText(orca)} and #notes`,
    );
    assert.equal(expandProjectMentions("no hash", [orca]), "no hash");
    assert.equal(expandProjectMentions("keep foo#bar", [orca]), "keep foo#bar");
  });

  it("uses the group alias, which is what list_chats takes", () => {
    assert.equal(expandProjectMentions("read #api", [api]), `read ${projectMentionModelText(api)}`);
    assert.match(projectMentionModelText(api), /^project api \(/);
  });
});

describe("displayProjectMentions", () => {
  it("folds the sent project back to #name", () => {
    assert.equal(
      displayProjectMentions(`check ${projectMentionModelText(orca)} today`, [orca]),
      "check #Orca today",
    );
    assert.equal(displayProjectMentions("just a note", [orca]), "just a note");
  });
});

describe("draftProjectMentionSpans", () => {
  it("marks a completed project mention and skips an unfinished one", () => {
    assert.deepEqual(draftProjectMentionSpans("#Orca hey #lad", [orca]), [
      { start: 0, end: "#Orca".length, project: orca },
    ]);
  });
});

describe("applyProjectMention", () => {
  it("replaces the open query with the project token", () => {
    const mention = projectMentionAtCursor("see #or", 7);
    assert.ok(mention);
    if (!mention) return;
    assert.deepEqual(applyProjectMention("see #or", mention, orca), {
      text: "see #Orca ",
      cursor: "see #Orca ".length,
    });
  });
});

describe("mentionProjectsFor", () => {
  const projects = [
    { name: "TwanAgent", path: "/Users/twan/orca/projects/TwanAgent" },
    { name: "Orca", path: "/Users/twan/orca" },
    { name: "api", path: "/Users/twan/api" },
    { name: "api", path: "/Users/twan/other/api" },
  ];
  const groups: ProjectGroupRow[] = [
    {
      path: "/Users/twan/group",
      name: "group",
      members: [
        { path: "/Users/twan/api", alias: "api", name: "api" },
        { path: "/Users/twan/orca", alias: "web", name: "Orca" },
      ],
    },
  ];

  it("skips the open project and names group members by alias", () => {
    const rows = mentionProjectsFor("/Users/twan/group", [...projects, { name: "group", path: "/Users/twan/group" }], groups);
    assert.equal(rows.find((row) => row.path.endsWith("/group")), undefined);
    assert.equal(rows.find((row) => row.path === "/Users/twan/api")?.token, "api");
    assert.equal(rows.find((row) => row.path === "/Users/twan/orca")?.token, "web");
    assert.equal(rows.find((row) => row.path === "/Users/twan/orca")?.alias, "web");
  });

  it("splits two folders that share a name", () => {
    const rows = mentionProjectsFor("/Users/twan/group", projects, groups);
    const tokens = rows.map((row) => row.token);
    assert.equal(new Set(tokens.map((token) => token.toLowerCase())).size, tokens.length);
    assert.ok(rows.some((row) => row.path === "/Users/twan/other/api" && row.token.endsWith("api")));
  });

  it("slugs a folder name that contains a space", () => {
    const rows = mentionProjectsFor("", [{ name: "My Project", path: "/Users/twan/My Project" }], []);
    assert.equal(rows[0]?.token, "My-Project");
  });
});
