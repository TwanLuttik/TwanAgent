import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canDropOnDir,
  canMoveSelection,
  canRenameSelection,
  fileDirDropId,
  fileDirPathFromDropId,
  fileDropDest,
  fileDropTarget,
  fileRowDragId,
  fileRowPathFromDragId,
  nextFolderName,
  topLevelPaths,
  validEntryName,
  validNewFileName,
  type FileNode,
} from "../file-actions.ts";

function nodes(rows: FileNode[]): Map<string, FileNode> {
  return new Map(rows.map((row) => [row.path, row]));
}

const tree = nodes([
  { path: "src", kind: "dir" },
  { path: "src/a.ts", kind: "file" },
  { path: "src/lib", kind: "dir" },
  { path: "src/lib/b.ts", kind: "file" },
  { path: "readme.md", kind: "file" },
]);

describe("file selection rules", () => {
  it("keeps only the outer folder when a child is also selected", () => {
    assert.deepEqual(topLevelPaths(["src/lib/b.ts", "src", "src/lib", "readme.md"]), ["src", "readme.md"]);
  });

  it("renames only a single file or a single folder", () => {
    assert.equal(canRenameSelection(["src/a.ts"], tree), true);
    assert.equal(canRenameSelection(["src"], tree), true);
    assert.equal(canRenameSelection(["src/a.ts", "readme.md"], tree), false);
    assert.equal(canRenameSelection(["src", "readme.md"], tree), false);
  });

  it("moves files or folders, but not a mix", () => {
    assert.equal(canMoveSelection(["src/a.ts", "readme.md"], tree), true);
    assert.equal(canMoveSelection(["src", "src/lib"], tree), true);
    assert.equal(canMoveSelection(["src", "readme.md"], tree), false);
  });

  it("refuses a drop onto itself, a child, or the folder it already sits in", () => {
    assert.equal(canDropOnDir(["src/a.ts"], "src/lib", tree), true);
    assert.equal(canDropOnDir(["src/a.ts"], "src", tree), false);
    assert.equal(canDropOnDir(["src"], "src/lib", tree), false);
    assert.equal(canDropOnDir(["src", "readme.md"], "src/lib", tree), false);
    assert.equal(canDropOnDir(["src/lib"], "", tree), true);
    assert.equal(canDropOnDir(["src/a.ts"], "", tree), true);
    assert.equal(canDropOnDir(["src"], "", tree), false);
    assert.equal(canDropOnDir(["readme.md"], "", tree), false);
  });

  it("picks an unused folder name and rejects path characters", () => {
    assert.equal(nextFolderName(["src"]), "untitled folder");
    assert.equal(nextFolderName(["untitled folder", "Untitled Folder 2"]), "untitled folder 3");
    assert.equal(validEntryName("notes.md"), true);
    assert.equal(validEntryName("a/b"), false);
    assert.equal(validEntryName(".."), false);
    assert.equal(validNewFileName("notes.md"), true);
    assert.equal(validNewFileName(".env"), true);
    assert.equal(validNewFileName("readme"), false);
    assert.equal(validNewFileName("notes."), false);
    assert.equal(validNewFileName("a/b.ts"), false);
  });

  it("accepts dotfiles with or without another extension", () => {
    for (const name of [".env", ".gitignore", ".env.local", " .env "]) {
      assert.equal(validNewFileName(name), true, name);
    }
  });

  it("aims a pointer at the folder under it, or the project root", () => {
    assert.equal(fileDropDest("src", "dir", true), "src");
    assert.equal(fileDropDest("src/a.ts", "file", true), "src");
    assert.equal(fileDropDest("readme.md", "file", true), "");
    assert.equal(fileDropDest(null, null, true), "");
    assert.equal(fileDropDest("src", "dir", false), null);
  });

  it("keeps a drop only when the folder can take the selection", () => {
    assert.equal(fileDropTarget(["src/a.ts"], "src/lib", tree), "src/lib");
    assert.equal(fileDropTarget(["src/a.ts"], "", tree), "");
    assert.equal(fileDropTarget(["src/a.ts"], "src", tree), null);
    assert.equal(fileDropTarget(["src"], "src/lib", tree), null);
    assert.equal(fileDropTarget(["src", "readme.md"], "src/lib", tree), null);
    assert.equal(fileDropTarget(["readme.md"], null, tree), null);
  });

  it("round-trips row and folder ids that contain colons", () => {
    assert.equal(fileRowPathFromDragId(fileRowDragId("src/a:b.ts")), "src/a:b.ts");
    assert.equal(fileDirPathFromDropId(fileDirDropId("")), "");
    assert.equal(fileDirPathFromDropId(fileDirDropId("src/lib")), "src/lib");
    assert.equal(fileRowPathFromDragId("other"), null);
    assert.equal(fileDirPathFromDropId(fileRowDragId("src")), null);
  });

  it("rejects empty, path, and trailing-dot file names", () => {
    for (const name of ["", " ", ".", "..", "readme", "notes.", ".env.", "a/b.ts", "a\\b.ts", ".env\0"]) {
      assert.equal(validNewFileName(name), false, JSON.stringify(name));
    }
  });
});
