import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  inlineCodeValues,
  looksLikeWorkspacePath,
  normalizeWorkspacePath,
} from "./workspace-path.ts";

describe("looksLikeWorkspacePath", () => {
  it("accepts relative files and nested paths", () => {
    assert.equal(looksLikeWorkspacePath("src/lib/core.ts"), true);
    assert.equal(looksLikeWorkspacePath("src-tauri/Cargo.toml"), true);
    assert.equal(looksLikeWorkspacePath("store.rs"), true);
    assert.equal(looksLikeWorkspacePath("README.md"), true);
    assert.equal(looksLikeWorkspacePath(".gitignore"), true);
    assert.equal(looksLikeWorkspacePath("package.json"), true);
  });

  it("rejects command labels and plain words", () => {
    assert.equal(looksLikeWorkspacePath("TBD"), false);
    assert.equal(looksLikeWorkspacePath("mod store"), false);
    assert.equal(looksLikeWorkspacePath("journey:"), false);
    assert.equal(looksLikeWorkspacePath("journey_id"), false);
    assert.equal(looksLikeWorkspacePath("list_conversations"), false);
    assert.equal(looksLikeWorkspacePath("https://example.com/a.ts"), false);
  });
});

describe("normalizeWorkspacePath", () => {
  it("trims and drops a leading ./", () => {
    assert.equal(normalizeWorkspacePath("  ./src/lib/core.ts  "), "src/lib/core.ts");
    assert.equal(normalizeWorkspacePath("src\\lib\\core.ts"), "src/lib/core.ts");
  });
});

describe("inlineCodeValues", () => {
  it("collects inline code and skips fenced blocks", () => {
    const text = [
      "See `src/lib/core.ts` and `TBD`.",
      "",
      "```",
      "src/lib/ignored.ts",
      "```",
      "",
      "Also `./src-tauri/src/lib.rs`.",
    ].join("\n");
    assert.deepEqual(inlineCodeValues(text), ["src/lib/core.ts", "TBD", "./src-tauri/src/lib.rs"]);
  });
});
