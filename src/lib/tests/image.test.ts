import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatMessage } from "../core.ts";
import {
  IMAGE_MAX_EDGE,
  MAX_PROMPT_IMAGES,
  appendPromptImages,
  canSendPrompt,
  imageBeforeCursor,
  imageSpans,
  imageToken,
  imageTokenLabel,
  insertImageToken,
  removeImageSpan,
  removeImageTokens,
  stripImageTokens,
  uniqueImageTokenLabel,
  fileToBase64,
  imageFilesFromClipboard,
  imageFilesFromDrop,
  imagePathsFromDrop,
  isImageFile,
  needsResize,
  persistableImages,
  persistableMessages,
  setImagesForChat,
  imagesForChat,
  targetSize,
  withImageDataUrls,
  type ChatImage,
} from "../image.ts";

const shot: ChatImage = {
  id: "img-1",
  path: "/tmp/attachments/inbox/img-1.jpg",
  name: "shot.png",
  mime: "image/jpeg",
  width: 2048,
  height: 1024,
  resized: true,
  dataUrl: "data:image/jpeg;base64,abc",
};

describe("isImageFile", () => {
  it("accepts raster images by mime or extension", () => {
    assert.equal(isImageFile({ type: "image/png", name: "a.png" }), true);
    assert.equal(isImageFile({ type: "image/jpeg", name: "a.jpg" }), true);
    assert.equal(isImageFile({ type: "", name: "shot.JPEG" }), true);
    assert.equal(isImageFile({ type: "image/webp", name: "a.webp" }), true);
    assert.equal(isImageFile({ type: "image/heic", name: "a.heic" }), true);
    assert.equal(isImageFile({ type: "image/heif-sequence", name: "a.heif" }), true);
    assert.equal(isImageFile({ type: "", name: "IMG_0001.HEIC" }), true);
    assert.equal(isImageFile({ type: "public.heic", name: "paste" }), true);
  });

  it("rejects non-images and svg", () => {
    assert.equal(isImageFile({ type: "text/plain", name: "a.txt" }), false);
    assert.equal(isImageFile({ type: "image/svg+xml", name: "a.svg" }), false);
    assert.equal(isImageFile({ type: "", name: "notes.md" }), false);
    assert.equal(isImageFile({ type: "image/svg+xml", name: "photo.heic" }), false);
  });
});

describe("imageFilesFromClipboard", () => {
  it("detects a pasted screenshot item", () => {
    const file = { type: "image/png", name: "image.png" };
    const found = imageFilesFromClipboard({
      items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
      files: [file],
    });
    assert.deepEqual(found, [file]);
  });

  it("ignores a text-only paste", () => {
    const found = imageFilesFromClipboard({
      items: [{ kind: "string", type: "text/plain", getAsFile: () => null }],
      files: [],
    });
    assert.deepEqual(found, []);
  });

  it("takes dropped image files and skips others", () => {
    const png = { type: "image/png", name: "a.png" };
    const txt = { type: "text/plain", name: "a.txt" };
    assert.deepEqual(imageFilesFromDrop([png, txt]), [png]);
  });
});

describe("imagePathsFromDrop", () => {
  it("keeps raster image paths from a native file drop", () => {
    assert.deepEqual(
      imagePathsFromDrop([
        "/Users/me/Desktop/shot.PNG",
        "/Users/me/notes.md",
        "C:\\tmp\\photo.jpeg",
        "/tmp/icon.svg",
        "/Users/me/Pictures/IMG_0001.HEIC",
      ]),
      ["/Users/me/Desktop/shot.PNG", "C:\\tmp\\photo.jpeg", "/Users/me/Pictures/IMG_0001.HEIC"],
    );
  });
});

describe("needsResize", () => {
  it("flags images whose long edge is over the cap", () => {
    assert.equal(needsResize(800, 600), false);
    assert.equal(needsResize(IMAGE_MAX_EDGE, 100), false);
    assert.equal(needsResize(IMAGE_MAX_EDGE + 1, 100), true);
    assert.equal(needsResize(100, 4000), true);
  });

  it("scales the long edge down and keeps aspect", () => {
    assert.deepEqual(targetSize(800, 600), { width: 800, height: 600 });
    assert.deepEqual(targetSize(4096, 2048), { width: 2048, height: 1024 });
  });
});

describe("prompt images", () => {
  it("allows send with only images", () => {
    assert.equal(canSendPrompt("", [shot]), true);
    assert.equal(canSendPrompt("  ", []), false);
    assert.equal(canSendPrompt("hi", []), true);
  });

  it("caps how many images can sit on the prompt", () => {
    const extras = Array.from({ length: MAX_PROMPT_IMAGES + 2 }, (_, i) => ({
      ...shot,
      id: `img-${i}`,
    }));
    assert.equal(appendPromptImages([], extras).length, MAX_PROMPT_IMAGES);
  });

  it("keeps draft images isolated by chat", () => {
    let drafts = setImagesForChat({}, "a", [shot]);
    drafts = setImagesForChat(drafts, "b", [{ ...shot, id: "img-2" }]);
    assert.equal(imagesForChat(drafts, "a")[0]?.id, "img-1");
    drafts = setImagesForChat(drafts, "a", []);
    assert.equal(imagesForChat(drafts, "a").length, 0);
    assert.equal(imagesForChat(drafts, "b").length, 1);
  });

  it("strips send-only data URLs before persist", () => {
    assert.equal(persistableImages([shot])[0]?.dataUrl, undefined);
    const msgs = persistableMessages([
      { role: "user", content: "see", images: [shot] },
    ] satisfies ChatMessage[]);
    assert.equal(msgs[0]?.images?.[0]?.dataUrl, undefined);
    assert.equal(msgs[0]?.images?.[0]?.path, shot.path);
  });
});

describe("withImageDataUrls", () => {
  it("loads missing data URLs from disk paths", async () => {
    const loaded = await withImageDataUrls(
      [{ role: "user", content: "see", images: [{ ...shot, dataUrl: undefined }] }],
      async (path) => {
        assert.equal(path, shot.path);
        return "data:image/jpeg;base64,zz";
      },
    );
    assert.equal(loaded[0]?.images?.[0]?.dataUrl, "data:image/jpeg;base64,zz");
  });

  it("reuses a cached data URL instead of reading the file again", async () => {
    const cache = new Map<string, string>([[shot.path, "data:image/jpeg;base64,cached"]]);
    let reads = 0;
    const loaded = await withImageDataUrls(
      [{ role: "user", content: "see", images: [{ ...shot, dataUrl: undefined }] }],
      async () => {
        reads += 1;
        return "data:image/jpeg;base64,fresh";
      },
      cache,
    );
    assert.equal(reads, 0);
    assert.equal(loaded[0]?.images?.[0]?.dataUrl, "data:image/jpeg;base64,cached");
  });
});

describe("image tokens", () => {
  it("inserts [name] at the caret and spaces it off neighboring words", () => {
    const next = insertImageToken("look at this please", 12, 12, "shot.png");
    assert.equal(next.token, "[shot.png]");
    assert.equal(next.draft, "look at this [shot.png] please");
    assert.equal(next.cursor, 12 + " [shot.png]".length);
  });

  it("replaces a selection and does not double the surrounding space", () => {
    const next = insertImageToken("see  this", 4, 5, "/Users/me/Desktop/diagram.webp");
    assert.equal(next.draft, "see [diagram.webp] this");
    assert.equal(next.cursor, "see [diagram.webp]".length);
  });

  it("numbers a second image that shares the filename", () => {
    assert.equal(uniqueImageTokenLabel("shot.png", []), "shot.png");
    assert.equal(uniqueImageTokenLabel("shot.png", ["shot.png"]), "shot-2.png");
    assert.equal(uniqueImageTokenLabel("shot.png", ["Shot.png", "shot-2.png"]), "shot-3.png");
    assert.equal(imageToken("image.png"), "[image.png]");
  });

  it("numbers a second screenshot whose name is already truncated", () => {
    const name = "CleanShot 2026-10-23 at 3.38.14 PM.png";
    const first = uniqueImageTokenLabel(name, []);
    const second = uniqueImageTokenLabel(name, [first]);
    assert.equal(first, "CleanShot 202...");
    assert.notEqual(second.toLowerCase(), first.toLowerCase());
    assert.ok([...second].length <= 16, second);
    assert.match(second, /-2/);
  });

  it("keeps the bracket placeholder to 16 characters", () => {
    assert.equal(imageTokenLabel("short.png"), "short.png");
    assert.equal(imageTokenLabel("CleanShot 2026-10-23 at 3.38.14 PM.png"), "CleanShot 202...");
    assert.equal(imageToken("CleanShot 2026-10-23 at 3.38.14 PM.png"), "[CleanShot 202...]");
    assert.equal([...imageTokenLabel("a".repeat(16))].length, 16);
    assert.equal([...imageTokenLabel("a".repeat(17))].length, 16);
  });

  it("finds only tokens that belong to an attached image", () => {
    const other = { ...shot, id: "img-2", name: "other.png" };
    const spans = imageSpans("see [shot.png] and [notes.md] plus [other.png]", [shot, other]);
    assert.deepEqual(
      spans.map((span) => span.label),
      ["shot.png", "other.png"],
    );
    assert.equal(spans[0]?.id, "img-1");
  });

  it("strips image markers from the text the model reads", () => {
    assert.equal(
      stripImageTokens("what is wrong in [shot.png] here", [shot]),
      "what is wrong in here",
    );
    assert.equal(stripImageTokens("keep [shot.png] typed", []), "keep [shot.png] typed");
    assert.equal(stripImageTokens("only [shot.png]", [shot]), "only");
  });

  it("deletes the whole token from anywhere inside it", () => {
    const draft = "see [shot.png]";
    const end = imageBeforeCursor(draft, draft.length, draft.length, [shot]);
    assert.ok(end);
    assert.equal(removeImageSpan(draft, end!).text, "see ");
    const inside = draft.indexOf("shot") + 2;
    const mid = imageBeforeCursor(draft, inside, inside, [shot]);
    assert.equal(mid?.label, "shot.png");
    assert.equal(imageBeforeCursor(draft, draft.indexOf("["), draft.indexOf("["), [shot]), null);
    assert.equal(imageBeforeCursor(draft, 0, draft.length, [shot]), null);
    assert.equal(removeImageTokens("keep [shot.png] and [other.png]", shot), "keep  and [other.png]");
  });
});

describe("fileToBase64", () => {
  it("encodes blob bytes", async () => {
    const blob = new Blob([Uint8Array.from([1, 2, 3, 4])]);
    assert.equal(await fileToBase64(blob), btoa("\u0001\u0002\u0003\u0004"));
  });
});
