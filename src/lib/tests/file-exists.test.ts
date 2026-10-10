import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  fileExistsSnapshot,
  publishFileExists,
  refreshFileExists,
  resetFileExistsForTests,
  subscribeFileExists,
  uncachedFileExists,
  watchFileRefresh,
} from "../file-exists.ts";

afterEach(() => resetFileExistsForTests());

describe("file existence snapshots", () => {
  it("does not notify when a refresh finds the same files", () => {
    let notices = 0;
    subscribeFileExists(() => {
      notices += 1;
    });
    publishFileExists("/repo", "src/a.ts", ["src/a.ts"], new Set(["src/a.ts"]));
    assert.equal(notices, 1);
    publishFileExists("/repo", "src/a.ts", ["src/a.ts"], new Set(["src/a.ts"]));
    assert.equal(notices, 1);
    assert.equal(fileExistsSnapshot("/repo", "src/a.ts").has("src/a.ts"), true);
  });

  it("notifies when a refresh finds a new file", () => {
    let notices = 0;
    subscribeFileExists(() => {
      notices += 1;
    });
    publishFileExists("/repo", "src/a.ts\0src/b.ts", ["src/a.ts", "src/b.ts"], new Set(["src/a.ts"]));
    publishFileExists("/repo", "src/a.ts\0src/b.ts", ["src/a.ts", "src/b.ts"], new Set(["src/a.ts", "src/b.ts"]));
    assert.equal(notices, 2);
  });

  it("returns one set when another bubble already checked these paths", () => {
    publishFileExists("/repo", "src/a.ts\0src/b.ts", ["src/a.ts", "src/b.ts"], new Set(["src/a.ts"]));
    const first = fileExistsSnapshot("/repo", "src/a.ts");
    const second = fileExistsSnapshot("/repo", "src/a.ts");
    assert.equal(first, second);
    assert.equal(first.has("src/a.ts"), true);
    assert.equal(first.has("src/b.ts"), false);
  });

  it("remembers a path so another bubble does not stat it again", () => {
    publishFileExists("/repo", "src/a.ts", ["src/a.ts"], new Set(["src/a.ts"]));
    assert.deepEqual(uncachedFileExists("/repo", ["src/a.ts", "src/b.ts"]), ["src/b.ts"]);
    assert.equal(fileExistsSnapshot("/repo", "src/a.ts").has("src/a.ts"), true);
  });

  it("asks watchers to refetch without clearing the current snapshot", () => {
    publishFileExists("/repo", "src/a.ts", ["src/a.ts"], new Set(["src/a.ts"]));
    let runs = 0;
    watchFileRefresh(() => {
      runs += 1;
    });
    refreshFileExists();
    assert.equal(runs, 1);
    assert.equal(fileExistsSnapshot("/repo", "src/a.ts").has("src/a.ts"), true);
  });
});
