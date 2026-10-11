import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  bumpFileRefresh,
  dirsToList,
  fileRefreshRevision,
  fileStructureDirs,
  fileStructureFiles,
  fileStructureSignature,
  publishFileStructure,
  resetFileStructureForTests,
  subscribeFileRefresh,
  subscribeFileStructure,
} from "../file-structure.ts";

afterEach(() => resetFileStructureForTests());

describe("file structure signatures", () => {
  it("notifies once when the first snapshot arrives", () => {
    let notices = 0;
    subscribeFileStructure(() => {
      notices += 1;
    });
    assert.equal(publishFileStructure("/repo", "aaa", ["src"], [{ path: "src/a.ts", name: "a.ts" }]), false);
    assert.equal(notices, 1);
    assert.equal(fileStructureSignature("/repo"), "aaa");
    assert.equal(publishFileStructure("/repo", "aaa", ["src"], [{ path: "src/a.ts", name: "a.ts" }]), false);
    assert.equal(notices, 1);
  });

  it("refreshes when a later snapshot has a different tree", () => {
    let notices = 0;
    subscribeFileStructure(() => {
      notices += 1;
    });
    publishFileStructure("/repo", "aaa");
    assert.equal(notices, 1);
    assert.equal(publishFileStructure("/repo", "aaa"), false);
    assert.equal(notices, 1);
    assert.equal(publishFileStructure("/repo", "bbb"), true);
    assert.equal(notices, 2);
  });

  it("lists only the next folder under one that is open", () => {
    const tree = ["src", "src/new", "src/new/deep", "other"];
    assert.deepEqual(dirsToList({ "": true, src: true }, tree), ["", "src", "src/new", "other"]);
    assert.deepEqual(dirsToList({ "": true }, tree), ["", "src", "other"]);
    assert.deepEqual(dirsToList({ "": true, src: false }, tree), ["", "src", "other"]);
  });

  it("keeps file paths from the snapshot for mentions", () => {
    publishFileStructure("/repo", "aaa", ["src"], [{ path: "src/a.ts", name: "a.ts" }]);
    assert.deepEqual(fileStructureFiles("/repo"), [{ path: "src/a.ts", name: "a.ts" }]);
    publishFileStructure("/repo", "aaa", ["src"], []);
    assert.deepEqual(fileStructureFiles("/repo"), [{ path: "src/a.ts", name: "a.ts" }]);
  });

  it("bumps a refresh revision without pretending the tree changed", () => {
    let treeNotices = 0;
    let refreshNotices = 0;
    subscribeFileStructure(() => {
      treeNotices += 1;
    });
    subscribeFileRefresh(() => {
      refreshNotices += 1;
    });
    publishFileStructure("/repo", "aaa", ["src"]);
    assert.equal(fileRefreshRevision(), 0);
    bumpFileRefresh();
    bumpFileRefresh();
    assert.equal(fileRefreshRevision(), 2);
    assert.equal(refreshNotices, 2);
    assert.equal(treeNotices, 1);
    assert.equal(fileStructureSignature("/repo"), "aaa");
  });

  it("keeps projects separate", () => {
    publishFileStructure("/local", "aaa", ["src"]);
    publishFileStructure("/remote", "bbb", ["app"]);
    assert.equal(fileStructureSignature("/local"), "aaa");
    assert.equal(fileStructureSignature("/remote"), "bbb");
    assert.deepEqual(fileStructureDirs("/local"), ["src"]);
    assert.equal(publishFileStructure("/local", "bbb", ["docs"]), true);
    assert.equal(fileStructureSignature("/remote"), "bbb");
    assert.deepEqual(fileStructureDirs("/remote"), ["app"]);
  });
});
