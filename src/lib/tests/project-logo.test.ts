import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nestedLogoDirs, pickProjectLogo, rootLogoDirs } from "../project-logo.ts";

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

  it("uses a favicon or logo in a known folder", () => {
    assert.equal(
      pickProjectLogo([
        { path: "logo.svg" },
        { path: "public/favicon.ico" },
      ]),
      "public/favicon.ico",
    );
    assert.equal(pickProjectLogo([{ path: "src/app/favicon.ico" }]), "src/app/favicon.ico");
    assert.equal(pickProjectLogo([{ path: "app/icon.png" }, { path: "README.md" }]), "app/icon.png");
    assert.equal(
      pickProjectLogo([{ path: "src/logo.svg" }, { path: "assets/logo.png" }]),
      "src/logo.svg",
    );
  });

  it("prefers a shallower file, then the usual folder", () => {
    assert.equal(
      pickProjectLogo([{ path: "public/favicon.png" }, { path: "favicon.svg" }]),
      "favicon.svg",
    );
    assert.equal(
      pickProjectLogo([{ path: "app/favicon.ico" }, { path: "public/favicon.ico" }]),
      "public/favicon.ico",
    );
  });

  it("ignores images that are not a project logo and images in other folders", () => {
    assert.equal(
      pickProjectLogo([
        { path: "src/components/logo.svg" },
        { path: "screenshot.png" },
        { path: "docs/favicon.ico" },
        { path: "node_modules/pkg/logo.svg" },
      ]),
      null,
    );
  });

  it("matches names without caring about case", () => {
    assert.equal(pickProjectLogo([{ path: "Favicon.ICO" }, { path: "Logo.SVG" }]), "Favicon.ICO");
    assert.equal(pickProjectLogo([{ name: "Logo.SVG", path: "Logo.SVG" }]), "Logo.SVG");
    assert.equal(pickProjectLogo([{ path: "Public/Favicon.ICO" }]), "Public/Favicon.ICO");
  });
});

describe("logo directories", () => {
  it("lists only the known folders at the project root", () => {
    assert.deepEqual(
      rootLogoDirs([
        { path: "public", kind: "dir" },
        { path: "src", kind: "dir" },
        { path: "docs", kind: "dir" },
        { path: "README.md", kind: "file" },
        { path: "Public", kind: "dir" },
      ]),
      ["public", "src"],
    );
    assert.deepEqual(rootLogoDirs([{ path: "Public", kind: "dir" }]), ["Public"]);
  });

  it("lists the second-level icon folders", () => {
    assert.deepEqual(
      nestedLogoDirs([
        { path: "src/app", kind: "dir" },
        { path: "src/components", kind: "dir" },
        { path: "src/assets", kind: "dir" },
        { path: "src/app/favicon.ico", kind: "file" },
      ]),
      ["src/app", "src/assets"],
    );
  });
});
