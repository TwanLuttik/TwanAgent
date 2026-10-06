import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileFolderLabel, fileKindLabel, formatFileBytes, formatLineCount } from "../file-preview.ts";

describe("fileKindLabel", () => {
  it("names common source files", () => {
    assert.equal(fileKindLabel("src/views/MainView.tsx"), "TSX");
    assert.equal(fileKindLabel("src/lib/core.ts"), "TypeScript");
    assert.equal(fileKindLabel("src-tauri/src/dev.rs"), "Rust");
  });
});

describe("fileFolderLabel", () => {
  it("returns the parent path", () => {
    assert.equal(fileFolderLabel("src/lib/core.ts"), "src/lib");
    assert.equal(fileFolderLabel("README.md"), "");
  });
});

describe("formatFileBytes", () => {
  it("uses compact units", () => {
    assert.equal(formatFileBytes(12), "12 B");
    assert.equal(formatFileBytes(1500), "1.5 KB");
    assert.equal(formatFileBytes(24100), "24 KB");
    assert.equal(formatFileBytes(1_200_000), "1.2 MB");
  });
});

describe("formatLineCount", () => {
  it("pluralizes", () => {
    assert.equal(formatLineCount(1), "1 line");
    assert.equal(formatLineCount(12), "12 lines");
  });
});
