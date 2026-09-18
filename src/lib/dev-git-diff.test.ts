import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addedFileDiff, groupDiffByFile, gutterMarksFromDiff, parseGitDiff } from "./dev-git-diff.ts";

describe("parseGitDiff", () => {
  it("splits staged and unstaged sections and numbers hunk lines", () => {
    const text = `# staged
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 keep
-old
+new
+extra
# unstaged
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -2,2 +2,2 @@
 context
-later
+now
`;
    const sections = parseGitDiff(text);
    assert.deepEqual(
      sections.map((s) => s.label),
      ["staged", "unstaged"],
    );
    const staged = sections[0].lines.filter((l) => l.kind === "add" || l.kind === "del" || l.kind === "context");
    assert.deepEqual(
      staged.map((l) => [l.kind, l.text, l.oldNo, l.newNo]),
      [
        ["context", "keep", 1, 1],
        ["del", "old", 2, undefined],
        ["add", "new", undefined, 2],
        ["add", "extra", undefined, 3],
      ],
    );
  });

  it("groups a multi-file diff by path", () => {
    const files = groupDiffByFile(
      parseGitDiff(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,2 @@
 keep
+added
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,1 @@
-old
+new
`),
    );
    assert.deepEqual(
      files.map((file) => file.path),
      ["src/a.ts", "src/b.ts"],
    );
    assert.equal(files[0].lines.some((line) => line.kind === "add" && line.text === "added"), true);
    assert.equal(files[1].lines.some((line) => line.kind === "del" && line.text === "old"), true);
  });

  it("treats a plain unified diff as one unlabeled section", () => {
    const sections = parseGitDiff(`@@ -10,1 +10,2 @@ fn main
 unchanged
+added
`);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].label, undefined);
    assert.equal(sections[0].lines[0].kind, "hunk");
    assert.equal(sections[0].lines[2].kind, "add");
    assert.equal(sections[0].lines[2].newNo, 11);
  });

  it("returns an empty list for blank input", () => {
    assert.deepEqual(parseGitDiff(""), []);
    assert.deepEqual(parseGitDiff("   \n"), []);
  });
});

describe("gutterMarksFromDiff", () => {
  it("marks replaced lines as modified and extra lines as added", () => {
    const sections = parseGitDiff(`@@ -1,3 +1,4 @@
 keep
-old
+new
+extra
 stay
`);
    const marks = gutterMarksFromDiff(sections);
    assert.equal(marks.get(1), undefined);
    assert.equal(marks.get(2), "mod");
    assert.equal(marks.get(3), "add");
    assert.equal(marks.get(4), undefined);
  });

  it("marks a deletion on the following line", () => {
    const sections = parseGitDiff(`@@ -2,3 +2,2 @@
 stay
-gone
 last
`);
    const marks = gutterMarksFromDiff(sections);
    assert.equal(marks.get(2), undefined);
    assert.equal(marks.get(3), "del");
  });

  it("puts a deletion mark on the previous line when nothing follows", () => {
    const sections = parseGitDiff(`@@ -8,2 +8,1 @@
 last
-gone
`);
    const marks = gutterMarksFromDiff(sections);
    assert.equal(marks.get(8), "del");
  });

  it("marks every line of a new file as added", () => {
    const marks = gutterMarksFromDiff(parseGitDiff(addedFileDiff("a.ts", "one\ntwo\n")));
    assert.equal(marks.get(1), "add");
    assert.equal(marks.get(2), "add");
  });
});

describe("addedFileDiff", () => {
  it("builds a unified diff for a new file", () => {
    const text = addedFileDiff("src/new.ts", "one\ntwo\n");
    const sections = parseGitDiff(text);
    const body = sections[0].lines.filter((l) => l.kind === "add");
    assert.deepEqual(
      body.map((l) => l.text),
      ["one", "two"],
    );
    assert.equal(body[0].newNo, 1);
    assert.equal(body[1].newNo, 2);
  });
});
