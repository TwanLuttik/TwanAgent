import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GitWorktree } from "../tauri.ts";
import {
  groupProjectsByWorktree,
  publishWorktreeLists,
  freshWorktreeName,
  hideOpenWorktreeMarker,
  rememberWorktreeName,
  takeWorktreeName,
  worktreeChoices,
  worktreeForPath,
  worktreeListsFor,
  provisionalWorktreeName,
  worktreeNameFromPrompt,
  worktreeNameFromSuggestion,
  worktreeNamePrompt,
  worktreeRepoKey,
} from "../worktree.ts";

function tree(path: string, branch: string | null, main = false, extra: Partial<GitWorktree> = {}): GitWorktree {
  return {
    path,
    head: "abc",
    branch,
    bare: false,
    detached: branch == null,
    main,
    ...extra,
  };
}

const main = tree("/work/billing", "main", true);
const login = tree("/work/billing-worktrees/feat-login", "feat/login");
const notes = tree("/work/billing-worktrees/notes", null);

describe("groupProjectsByWorktree", () => {
  it("leaves projects alone when they have no worktree list", () => {
    const rows = [
      { name: "Billing", path: "/work/billing" },
      { name: "Other", path: "/work/other" },
    ];
    const grouped = groupProjectsByWorktree(rows, {});
    assert.equal(grouped.length, 2);
    assert.deepEqual(grouped[0].children, []);
    assert.equal(grouped[1].path, "/work/other");
  });

  it("nests linked checkouts under the main project and drops them from the top", () => {
    const rows = [
      { name: "Billing", path: "/work/billing" },
      { name: "feat-login", path: "/work/billing-worktrees/feat-login" },
      { name: "notes", path: "/work/billing-worktrees/notes" },
      { name: "Other", path: "/work/other" },
    ];
    const list = [main, login, notes];
    const grouped = groupProjectsByWorktree(rows, {
      "/work/billing": list,
      "/work/billing-worktrees/feat-login": list,
      "/work/billing-worktrees/notes": list,
    });
    assert.deepEqual(
      grouped.map((row) => row.path),
      ["/work/billing", "/work/other"],
    );
    assert.deepEqual(
      grouped[0].children.map((child) => [child.name, child.branch]),
      [
        ["feat-login", "feat/login"],
        ["notes", "detached"],
      ],
    );
  });

  it("nests under the main project when only the linked checkout published the list", () => {
    const grouped = groupProjectsByWorktree(
      [
        { name: "Billing", path: main.path },
        { name: "feat-login", path: login.path },
      ],
      { [login.path]: [main, login] },
    );
    assert.deepEqual(
      grouped.map((row) => row.path),
      [main.path],
    );
    assert.deepEqual(grouped[0].children.map((child) => child.path), [login.path]);
  });

  it("still nests when only the linked checkout was asked", () => {
    const grouped = groupProjectsByWorktree([{ name: "feat-login", path: login.path }], {
      [login.path]: [main, login],
    });
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0].path, login.path);
    assert.equal(grouped[0].children.length, 1);
    assert.equal(grouped[0].children[0].path, login.path);
  });

  it("labels the open checkout and lists the rest of the repo", () => {
    const list = [main, login];
    const open = worktreeChoices(login.path, list);
    assert.equal(open.current?.branch, "feat/login");
    assert.equal(open.current?.current, true);
    assert.deepEqual(
      open.rows.map((row) => row.branch),
      ["main", "feat/login"],
    );
    assert.equal(worktreeChoices("/work/other", list).current, null);
    assert.equal(worktreeChoices(main.path, [main]).current?.main, true);
  });

  it("turns a suggestion into a branch and hides the marker", () => {
    assert.equal(worktreeNameFromSuggestion("Fix the login bug!"), "fix-the-login-bug");
    assert.equal(worktreeNameFromSuggestion("HEAD"), "");
    assert.equal(worktreeNameFromSuggestion("deadbeef"), "");
    const taken = takeWorktreeName("I'll start on the form.\n{{TwanAgent:feat/login-form}}");
    assert.equal(taken.name, "feat/login-form");
    assert.equal(taken.text, "I'll start on the form.");
    assert.equal(takeWorktreeName("no marker").name, "");
    assert.equal(hideOpenWorktreeMarker("Done. {{TwanAgent:feat").text, "Done.");
    assert.equal(hideOpenWorktreeMarker("Done. {{not a name").pending, false);
    assert.match(worktreeNamePrompt(false), /\{\{TwanAgent:branch-name\}\}/);
    assert.equal(worktreeNamePrompt(true), "");
    assert.equal(worktreeNameFromPrompt("  Fix the login bug please  "), "fix-the-login-bug-please");
    assert.equal(worktreeNameFromPrompt(""), "");
    assert.equal(provisionalWorktreeName("feat/login"), "wip-featlogin");
    assert.match(provisionalWorktreeName(), /^wip-[a-z0-9]+$/);
    assert.equal(freshWorktreeName("c1", "feat/login"), "feat/login");
    rememberWorktreeName("c1", "feat/login");
    assert.equal(freshWorktreeName("c1", "feat/other"), "");
  });

  it("publishes lists so a turn can find the open checkout", () => {
    publishWorktreeLists({ [main.path]: [main, login] });
    assert.equal(worktreeListsFor(login.path).length, 2);
    assert.equal(worktreeListsFor("/work/other").length, 0);
    publishWorktreeLists({});
    assert.equal(worktreeListsFor(login.path).length, 0);
  });

  it("shares one repo key for every checkout of the same git dir", () => {
    const list = [main, login];
    assert.equal(worktreeRepoKey(main.path, list), worktreeRepoKey(login.path, list));
    assert.equal(worktreeRepoKey("/work/other", null), "/work/other");
    assert.equal(worktreeForPath(login.path, list)?.branch, "feat/login");
    assert.equal(worktreeForPath("/work/missing", list), null);
  });
});
