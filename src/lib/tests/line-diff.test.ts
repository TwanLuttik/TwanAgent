import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactDiffRows, lineDiffRows } from "../line-diff.ts";

describe("lineDiffRows", () => {
  it("highlights only the changed words on a replaced line", () => {
    const rows = lineDiffRows(
      ['    assert.equal(fileBaseName("src/lib/dev.ts"), "dev.ts");'],
      ['    assert.equal(fileBaseName("src/lib/core.ts"), "core.ts");'],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.kind, "change");
    if (rows[0]?.kind !== "change") return;
    assert.deepEqual(
      rows[0].removed.filter((part) => part.changed).map((part) => part.text),
      ["dev.ts", "dev.ts"],
    );
    assert.deepEqual(
      rows[0].added.filter((part) => part.changed).map((part) => part.text),
      ["core.ts", "core.ts"],
    );
  });

  it("keeps an inserted line as a single addition", () => {
    const rows = lineDiffRows(["const a = 1;"], ["const a = 1;", "const b = 2;"]);
    assert.deepEqual(rows, [
      { kind: "same", text: "const a = 1;" },
      { kind: "add", text: "const b = 2;" },
    ]);
  });

  it("keeps a deleted line when nothing replaced it", () => {
    assert.deepEqual(lineDiffRows(["gone"], []), [{ kind: "del", text: "gone" }]);
  });
});

describe("compactDiffRows", () => {
  it("drops unchanged lines and keeps the changed words", () => {
    const rows = compactDiffRows(
      ["import { a } from './core';", 'className="m-0 text-[16px] font-semibold"'],
      ["import { a } from './core';", 'className="m-0 text-[13px] font-medium"'],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.kind, "change");
    if (rows[0]?.kind !== "change") return;
    assert.deepEqual(
      rows[0].removed.filter((part) => part.changed).map((part) => part.text),
      ["16px", "semibold"],
    );
    assert.deepEqual(
      rows[0].added.filter((part) => part.changed).map((part) => part.text),
      ["13px", "medium"],
    );
  });

  it("caps the peek at the requested number of changed rows", () => {
    const removed = ["a", "b", "c"];
    const added = ["x", "y", "z"];
    assert.equal(compactDiffRows(removed, added, 2).length, 2);
  });
});
