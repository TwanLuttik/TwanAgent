import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  fileExistsSnapshot,
  publishFileExists,
  refreshFileExists,
  resetFileExistsForTests,
  subscribeFileExists,
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
