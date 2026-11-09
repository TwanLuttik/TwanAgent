import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEMO_BYTES,
  DEMO_DOWNLOAD_MS,
  DEMO_INSTALL_MS,
  closeDemo,
  demoFrame,
  demoRelease,
  failDemo,
  openDemo,
  tickDemo,
  updateButtonLabel,
  updateCopy,
  updateDetail,
  updateNote,
  updateProgressLabel,
  versionCore,
  versionIsNewer,
  type UpdateModel,
} from "../update.ts";

describe("version compare", () => {
  it("strips the tag prefix and the build id", () => {
    assert.equal(versionCore("v1.0.0-beta.2+2672518"), "1.0.0-beta.2");
    assert.equal(versionCore(" 1.0.0-beta.2 "), "1.0.0-beta.2");
  });

  it("treats a later prerelease and a final release as newer", () => {
    assert.equal(versionIsNewer("1.0.0-beta.2", "1.0.0-beta.1"), true);
    assert.equal(versionIsNewer("1.0.0-beta.10", "1.0.0-beta.2"), true);
    assert.equal(versionIsNewer("1.0.0", "1.0.0-beta.2"), true);
    assert.equal(versionIsNewer("v1.0.0-beta.3", "1.0.0-beta.2+2672518"), true);
    assert.equal(versionIsNewer("1.1.0", "1.0.9"), true);
  });

  it("does not offer the installed version or an older one", () => {
    assert.equal(versionIsNewer("1.0.0-beta.2", "1.0.0-beta.2"), false);
    assert.equal(versionIsNewer("1.0.0-beta.2+aaaaaaa", "1.0.0-beta.2+bbbbbbb"), false);
    assert.equal(versionIsNewer("1.0.0-beta.1", "v1.0.0-beta.2"), false);
    assert.equal(versionIsNewer("0.9.0", "1.0.0-beta.1"), false);
  });
});

describe("update button", () => {
  it("names the step the button is on", () => {
    assert.equal(updateButtonLabel("idle"), "Update");
    assert.equal(updateButtonLabel("checking"), "Checking…");
    assert.equal(updateButtonLabel("downloading", 5_000_000, 20_000_000), "Downloading 4.77 MB");
    assert.equal(updateButtonLabel("installing"), "Installing…");
    assert.equal(updateButtonLabel("ready"), "Restart");
    assert.equal(updateButtonLabel("error"), "Retry");
  });

  it("keeps the first note short", () => {
    assert.equal(updateNote("macOS only.\n\nMore."), "macOS only.");
    assert.equal(updateNote("# Title\n\nA note."), "A note.");
    assert.equal(updateNote(""), "");
  });
});

function model(patch: Partial<UpdateModel> = {}): UpdateModel {
  return {
    update: null,
    phase: "idle",
    received: 0,
    total: 0,
    error: null,
    demo: false,
    held: null,
    ...patch,
  };
}

describe("update row copy", () => {
  it("shows the note, then progress, then the next step", () => {
    assert.equal(updateDetail("idle", "macOS only.", 0, 0, null), "macOS only.");
    assert.equal(updateProgressLabel(10_000_000, 20_000_000), "Downloading 9.54 MB of 19.1 MB");
    assert.equal(updateDetail("downloading", "macOS only.", 10_000_000, 20_000_000, null), "Downloading 9.54 MB of 19.1 MB");
    assert.equal(updateDetail("installing", "macOS only.", 20_000_000, 20_000_000, null), "Installing…");
    assert.equal(updateDetail("ready", "macOS only.", 20_000_000, 20_000_000, null), "Restart to open it.");
    assert.equal(updateDetail("error", "macOS only.", 0, 0, "Disk full."), "Disk full.");
    assert.equal(updateDetail("error", "macOS only.", 0, 0, "  "), "Update failed.");
  });
});

describe("update row copy", () => {
  it("leads with the status and keeps the version quiet", () => {
    assert.deepEqual(updateCopy("idle", "v1.0.0-beta.16+abc", "macOS only.\n\nMore.", 0, 0, null), {
      title: "1.0.0-beta.16",
      detail: "macOS only.",
    });
    assert.deepEqual(updateCopy("downloading", "1.0.0-beta.16", "note", 10_000_000, 20_000_000, null), {
      title: "Downloading",
      detail: "9.54 MB of 19.1 MB",
    });
    assert.deepEqual(updateCopy("installing", "1.0.0-beta.16", "note", 0, 0, null), {
      title: "Installing",
      detail: "1.0.0-beta.16",
    });
    assert.deepEqual(updateCopy("ready", "1.0.0-beta.99", "note", 0, 0, null), {
      title: "Update ready",
      detail: "1.0.0-beta.99",
    });
    assert.deepEqual(updateCopy("error", "1.0.0-beta.16", "note", 0, 0, "Disk full."), {
      title: "Update failed",
      detail: "Disk full.",
    });
    assert.deepEqual(updateCopy("error", "1.0.0-beta.16", "note", 0, 0, "  "), {
      title: "Update failed",
      detail: "",
    });
  });
});

describe("update demo", () => {
  it("offers a fake release and nothing to download", () => {
    const release = demoRelease();
    assert.equal(release.version, "1.0.0-beta.99");
    assert.equal(release.notes, "Demo release. Nothing is downloaded.");
    assert.equal(release.url, "");
    assert.equal(release.bytes, DEMO_BYTES);
    assert.equal(versionIsNewer(release.version, "1.0.0-beta.15"), true);
  });

  it("plays a download, a short install, then ready", () => {
    assert.deepEqual(demoFrame(0), { phase: "downloading", received: 0, total: DEMO_BYTES });
    assert.deepEqual(demoFrame(DEMO_DOWNLOAD_MS / 2), {
      phase: "downloading",
      received: DEMO_BYTES / 2,
      total: DEMO_BYTES,
    });
    assert.equal(demoFrame(DEMO_DOWNLOAD_MS - 1).phase, "downloading");
    assert.equal(demoFrame(DEMO_DOWNLOAD_MS).phase, "installing");
    assert.equal(demoFrame(DEMO_DOWNLOAD_MS).received, DEMO_BYTES);
    assert.equal(demoFrame(DEMO_DOWNLOAD_MS + DEMO_INSTALL_MS - 1).phase, "installing");
    assert.equal(demoFrame(DEMO_DOWNLOAD_MS + DEMO_INSTALL_MS).phase, "ready");
    assert.equal(demoFrame(-20).received, 0);
  });

  it("hides a real update while the demo plays and brings it back", () => {
    const real = { ...demoRelease(), version: "9.0.0", notes: "Real.", bytes: 100 };
    const open = openDemo(model({ update: real, total: 100 }));
    assert.equal(open.demo, true);
    assert.equal(open.phase, "idle");
    assert.equal(open.update?.version, "1.0.0-beta.99");
    assert.equal(open.held?.version, "9.0.0");
    assert.equal(open.error, null);

    const back = closeDemo(open);
    assert.equal(back.demo, false);
    assert.equal(back.update?.version, "9.0.0");
    assert.equal(back.update?.notes, "Real.");
    assert.equal(back.held, null);
    assert.equal(back.phase, "idle");
    assert.equal(back.total, 100);
  });

  it("moves a playing demo from download to ready", () => {
    const playing = { ...openDemo(model()), phase: "downloading" as const };
    const mid = tickDemo(playing, DEMO_DOWNLOAD_MS / 2);
    assert.equal(mid.phase, "downloading");
    assert.equal(mid.received, DEMO_BYTES / 2);
    assert.equal(tickDemo(playing, DEMO_DOWNLOAD_MS + DEMO_INSTALL_MS).phase, "ready");
  });

  it("fails only while a demo download or install is running", () => {
    const open = openDemo(model());
    assert.equal(failDemo(open).phase, "idle");
    assert.equal(failDemo({ ...open, demo: false, phase: "downloading" }).phase, "downloading");

    const failed = failDemo({ ...open, phase: "downloading", received: 10 });
    assert.equal(failed.phase, "error");
    assert.equal(failed.error, "Demo failed. Nothing was downloaded.");
    assert.equal(failed.update?.version, "1.0.0-beta.99");
    assert.equal(tickDemo(failed, DEMO_DOWNLOAD_MS).phase, "error");
    assert.equal(tickDemo(open, DEMO_DOWNLOAD_MS).phase, "idle");
  });

  it("does not open over a real install", () => {
    const busy = model({ phase: "downloading", update: demoRelease() });
    assert.equal(openDemo(busy), busy);
    assert.equal(openDemo(model({ phase: "installing" })).phase, "installing");
    assert.equal(openDemo(model({ phase: "ready" })).phase, "ready");
  });
});
