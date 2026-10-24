import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickProjectLogo } from "../project-logo.ts";

describe("pickProjectLogo", () => {
  it("prefers a favicon over every other logo", () => {
    assert.equal(
      pickProjectLogo([
        { path: "logo.svg" },
        { path: "icon.png" },
        { path: "favicon.ico" },
        { path: "public/favicon.ico" },
      ]),
      "favicon.ico",
    );
  });

  it("keeps the favicon even when a logo is listed first", () => {
    assert.equal(pickProjectLogo([{ path: "logo.png" }, { path: "favicon.png" }]), "favicon.png");
  });

  it("ranks favicon formats", () => {
    assert.equal(
      pickProjectLogo([{ path: "favicon.png" }, { path: "favicon.svg" }, { path: "favicon.ico" }]),
      "favicon.ico",
    );
    assert.equal(pickProjectLogo([{ path: "favicon.webp" }, { path: "favicon.png" }]), "favicon.png");
  });

  it("falls back to a logo or icon when no favicon exists", () => {
    assert.equal(pickProjectLogo([{ path: "README.md" }, { path: "logo.png" }]), "logo.png");
    assert.equal(pickProjectLogo([{ path: "icon.png" }, { path: "logo.svg" }]), "logo.svg");
    assert.equal(pickProjectLogo([{ path: "app-icon.png" }, { path: "icon.svg" }]), "icon.svg");
  });

  it("ignores images that are not a project logo and images in subfolders", () => {
    assert.equal(
      pickProjectLogo([
        { path: "src/logo.svg" },
        { path: "screenshot.png" },
        { path: "docs/favicon.ico" },
        { name: "logo.png", path: "assets/logo.png" },
      ]),
      null,
    );
  });

  it("matches names without caring about case", () => {
    assert.equal(pickProjectLogo([{ path: "Favicon.ICO" }, { path: "Logo.SVG" }]), "Favicon.ICO");
    assert.equal(pickProjectLogo([{ name: "Logo.SVG", path: "Logo.SVG" }]), "Logo.SVG");
  });
});
