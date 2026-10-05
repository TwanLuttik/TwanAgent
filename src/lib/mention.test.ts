import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyMention,
  displayFileMentions,
  draftMentionSpans,
  expandFileMentions,
  filterMentionFiles,
  mentionAtCursor,
  type MentionFile,
} from "./mention.ts";

const files: MentionFile[] = [
  { path: "src/lib/prefs.ts", name: "prefs.ts" },
  { path: "src/lib/prefs.test.ts", name: "prefs.test.ts" },
  { path: "src/views/MainView.tsx", name: "MainView.tsx" },
];

describe("mentionAtCursor", () => {
  it("reads the query after @ at the caret", () => {
    assert.deepEqual(mentionAtCursor("look at @pref", 14), { start: 8, end: 14, query: "pref" });
    assert.deepEqual(mentionAtCursor("@", 1), { start: 0, end: 1, query: "" });
    assert.equal(mentionAtCursor("email me@host", 13), null);
    assert.equal(mentionAtCursor("done @file ", 11), null);
  });
});

describe("filterMentionFiles", () => {
  it("prefers a name prefix over a later path match", () => {
    const rows = filterMentionFiles(files, "pref");
    assert.equal(rows[0]?.path, "src/lib/prefs.ts");
    assert.equal(rows[1]?.path, "src/lib/prefs.test.ts");
    assert.equal(filterMentionFiles(files, "missing").length, 0);
  });
});

describe("expandFileMentions", () => {
  it("turns a picked mention into its workspace path and leaves the rest", () => {
    assert.equal(
      expandFileMentions("please check @prefs.ts and @notes", [files[0]]),
      "please check src/lib/prefs.ts and @notes",
    );
    assert.equal(expandFileMentions("no mentions", files), "no mentions");
    assert.equal(expandFileMentions("mail me@host.com", files), "mail me@host.com");
  });
});

describe("displayFileMentions", () => {
  it("folds a sent workspace path back to @filename", () => {
    assert.equal(
      displayFileMentions(
        "for the packages/server/src/dashboard.ts , can we improve that",
        [{ path: "packages/server/src/dashboard.ts", name: "dashboard.ts" }],
      ),
      "for the @dashboard.ts , can we improve that",
    );
  });

  it("leaves prose and emails that only share a filename", () => {
    assert.equal(
      displayFileMentions("open dashboard.ts and mail me@host.com", [
        { path: "packages/server/src/dashboard.ts", name: "dashboard.ts" },
      ]),
      "open dashboard.ts and mail me@host.com",
    );
    assert.equal(displayFileMentions("just a note", []), "just a note");
  });

  it("picks the longer path when one file lives under another", () => {
    assert.equal(
      displayFileMentions("see src/lib/prefs.ts next", [
        { path: "src/lib/prefs.ts", name: "prefs.ts" },
        { path: "src/lib", name: "lib" },
      ]),
      "see @prefs.ts next",
    );
  });
});

describe("draftMentionSpans", () => {
  it("marks a completed file mention and skips an unfinished one", () => {
    assert.deepEqual(draftMentionSpans("@main.tsx hey @lad", [{ path: "src/main.tsx", name: "main.tsx" }]), [
      { start: 0, end: "@main.tsx".length, file: { path: "src/main.tsx", name: "main.tsx" } },
    ]);
  });
});

describe("applyMention", () => {
  it("replaces the open query with the file name", () => {
    const mention = mentionAtCursor("see @pre", 8);
    assert.ok(mention);
    if (!mention) return;
    assert.deepEqual(applyMention("see @pre", mention, files[0]), {
      text: "see @prefs.ts ",
      cursor: "see @prefs.ts ".length,
    });
  });
});
