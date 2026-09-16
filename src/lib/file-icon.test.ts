import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileBaseName, fileIconKind } from "./file-icon.ts";

describe("fileBaseName", () => {
  it("uses the last path segment", () => {
    assert.equal(fileBaseName("src/lib/dev.ts"), "dev.ts");
    assert.equal(fileBaseName("C:\\src\\App.tsx"), "App.tsx");
    assert.equal(fileBaseName("README.md"), "README.md");
  });
});

describe("fileIconKind", () => {
  it("maps common language extensions", () => {
    assert.equal(fileIconKind("index.js"), "js");
    assert.equal(fileIconKind("src/main.ts"), "ts");
    assert.equal(fileIconKind("App.tsx"), "tsx");
    assert.equal(fileIconKind("Button.jsx"), "jsx");
    assert.equal(fileIconKind("index.css"), "css");
    assert.equal(fileIconKind("index.html"), "html");
    assert.equal(fileIconKind("README.md"), "md");
    assert.equal(fileIconKind("build.rs"), "rs");
    assert.equal(fileIconKind("app.py"), "py");
    assert.equal(fileIconKind("vite.config.ts"), "ts");
    assert.equal(fileIconKind("foo.test.ts"), "ts");
  });

  it("maps config and data files", () => {
    assert.equal(fileIconKind("tauri.conf.json"), "json");
    assert.equal(fileIconKind("Cargo.toml"), "rs");
    assert.equal(fileIconKind("docker-compose.yml"), "docker");
    assert.equal(fileIconKind(".gitignore"), "git");
    assert.equal(fileIconKind(".env"), "env");
    assert.equal(fileIconKind(".env.local"), "env");
    assert.equal(fileIconKind("package.json"), "npm");
    assert.equal(fileIconKind("package-lock.json"), "lock");
    assert.equal(fileIconKind("Cargo.lock"), "lock");
    assert.equal(fileIconKind("tsconfig.json"), "ts");
    assert.equal(fileIconKind("tsconfig.app.json"), "ts");
  });

  it("maps media and archives", () => {
    assert.equal(fileIconKind("icon.png"), "image");
    assert.equal(fileIconKind("photo.heic"), "image");
    assert.equal(fileIconKind("logo.svg"), "svg");
    assert.equal(fileIconKind("clip.mp4"), "video");
    assert.equal(fileIconKind("take.m4v"), "video");
    assert.equal(fileIconKind("theme.woff2"), "font");
    assert.equal(fileIconKind("bundle.tgz"), "zip");
  });

  it("falls back to a generic document", () => {
    assert.equal(fileIconKind("unknown.bin"), "doc");
    assert.equal(fileIconKind("Makefile"), "make");
    assert.equal(fileIconKind("LICENSE"), "txt");
    assert.equal(fileIconKind("AGENTS.md"), "md");
  });
});
