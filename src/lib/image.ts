import type { ChatImage, ChatMessage } from "./core.ts";

export type { ChatImage };

export const IMAGE_MAX_EDGE = 2048;
export const MAX_PROMPT_IMAGES = 8;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|jfif|heic|heif)$/i;
// SVG is XML, not a bitmap the model can see. HEIC and HEIF are accepted and
// converted to JPEG or PNG before they are stored.
const REJECTED_IMAGE = /svg/;

export type FileLike = {
  type?: string;
  name?: string;
};

export type ClipboardLike = {
  items?: ArrayLike<{
    kind: string;
    type: string;
    getAsFile?: () => FileLike | null;
  }> | null;
  files?: Iterable<FileLike> | null;
};

export function mimeType(value: string): string {
  return value.toLowerCase().split(";")[0]?.trim() ?? "";
}

function isHeicMime(mime: string): boolean {
  return (
    mime === "image/heic" ||
    mime === "image/heif" ||
    mime === "image/heic-sequence" ||
    mime === "image/heif-sequence" ||
    mime === "public.heic" ||
    mime === "public.heif"
  );
}

export function isImageMime(value: string): boolean {
  const mime = mimeType(value);
  if (!mime || REJECTED_IMAGE.test(mime)) return false;
  if (isHeicMime(mime)) return true;
  if (!mime.startsWith("image/")) return false;
  return (
    mime === "image/png" ||
    mime === "image/jpeg" ||
    mime === "image/jpg" ||
    mime === "image/gif" ||
    mime === "image/webp" ||
    mime === "image/bmp" ||
    mime === "image/x-png"
  );
}

export function isImageFile(file: FileLike): boolean {
  if (file.type && isImageMime(file.type)) return true;
  if (file.type && REJECTED_IMAGE.test(mimeType(file.type))) return false;
  return IMAGE_EXT.test(file.name ?? "");
}

export function imageFilesFromDrop(files: Iterable<FileLike>): FileLike[] {
  return [...files].filter(isImageFile);
}

export function imagePathsFromDrop(paths: string[]): string[] {
  return paths.filter((path) => isImageFile({ name: path }));
}

export function imageFilesFromClipboard(data: ClipboardLike | null | undefined): FileLike[] {
  if (!data) return [];
  const out: FileLike[] = [];
  const seen = new Set<FileLike>();
  const items = data.items;
  for (let i = 0; i < (items?.length ?? 0); i++) {
    const item = items![i];
    if (item.kind !== "file" || !isImageMime(item.type)) continue;
    const file = item.getAsFile?.();
    if (!file || !isImageFile(file) || seen.has(file)) continue;
    seen.add(file);
    out.push(file);
  }
  for (const file of data.files ?? []) {
    if (seen.has(file) || !isImageFile(file)) continue;
    seen.add(file);
    out.push(file);
  }
  return out;
}

export function needsResize(width: number, height: number, maxEdge = IMAGE_MAX_EDGE): boolean {
  return Math.max(width, height) > maxEdge;
}

export function targetSize(
  width: number,
  height: number,
  maxEdge = IMAGE_MAX_EDGE,
): { width: number; height: number } {
  const edge = Math.max(width, height);
  if (edge <= maxEdge || edge <= 0) return { width, height };
  const scale = maxEdge / edge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function canSendPrompt(text: string, images: ChatImage[]): boolean {
  return Boolean(text.trim() || images.length);
}

const IMAGE_TOKEN = /\[([^\[\]\r\n]+)]/g;

/** Characters of the filename shown inside `[...]`. Longer names end in `...`. */
export const IMAGE_TOKEN_VISIBLE = 16;

/** Bracket token the composer inserts where an image was dropped. */
export function imageToken(name: string): string {
  return `[${imageTokenLabel(name)}]`;
}

/** A filename safe to sit inside `[...]`. Empty names become `image`. */
export function imageTokenLabel(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop()?.trim() ?? "";
  const cleaned = base.replace(/[\[\]\r\n]/g, "").trim();
  return truncateImageLabel(cleaned || "image");
}

/** Keep at most 16 characters. Anything longer keeps 13 and ends with `...`. */
export function truncateImageLabel(label: string): string {
  const text = label.trim();
  if ([...text].length <= IMAGE_TOKEN_VISIBLE) return text;
  return `${[...text].slice(0, IMAGE_TOKEN_VISIBLE - 3).join("")}...`;
}

/**
 * Unique label for a new image. A second `shot.png` becomes `shot-2.png`.
 * `taken` is every label already used, including ones typed by hand.
 * Long names are already cut to 16 characters, so the number is kept inside
 * that budget. Truncating after inserting it used to drop the number and loop
 * forever, which froze the window on the second screenshot.
 */
export function uniqueImageTokenLabel(name: string, taken: Iterable<string>): string {
  const label = imageTokenLabel(name);
  const used = new Set([...taken].map((item) => item.toLowerCase()));
  if (!used.has(label.toLowerCase())) return label;
  const dot = label.lastIndexOf(".");
  const stem = dot > 0 ? label.slice(0, dot) : label;
  const ext = dot > 0 ? label.slice(dot) : "";
  let n = 2;
  let next = numberedImageLabel(stem, n, ext);
  while (used.has(next.toLowerCase())) {
    n += 1;
    next = numberedImageLabel(stem, n, ext);
    if (n > 9999) return next;
  }
  return next;
}

/** `stem-n.ext` in at most 16 characters. The number is never the part that is cut. */
function numberedImageLabel(stem: string, n: number, ext: string): string {
  const suffix = `-${n}${ext}`;
  const room = IMAGE_TOKEN_VISIBLE - [...suffix].length;
  const head = room > 0 ? [...stem].slice(0, room).join("").trimEnd() : "";
  return `${head}${suffix}`;
}

export type ImageSpan = { start: number; end: number; id: string; label: string };

/** Ranges of `[name]` tokens that belong to an attached image. */
export function imageSpans(text: string, images: ChatImage[]): ImageSpan[] {
  if (!text.includes("[") || images.length === 0) return [];
  const byLabel = new Map<string, string>();
  for (const image of images) {
    const label = imageTokenLabel(image.name);
    const key = label.toLowerCase();
    if (!byLabel.has(key)) byLabel.set(key, image.id);
  }
  const spans: ImageSpan[] = [];
  const re = new RegExp(IMAGE_TOKEN.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const label = match[1] ?? "";
    const id = byLabel.get(label.toLowerCase());
    if (!id) continue;
    spans.push({ start: match.index, end: match.index + match[0].length, id, label });
  }
  return spans;
}

/**
 * Put `[name]` where the caret is. A selection is replaced.
 * Spaces are added so the token does not glue onto surrounding words.
 */
export function insertImageToken(
  draft: string,
  start: number,
  end: number,
  name: string,
): { draft: string; cursor: number; token: string } {
  const from = Math.max(0, Math.min(start, end, draft.length));
  const to = Math.max(0, Math.min(Math.max(start, end), draft.length));
  const token = imageToken(name);
  const lead = from > 0 && !/\s$/.test(draft.slice(0, from)) ? " " : "";
  const tail = to < draft.length && !/^\s/.test(draft.slice(to)) ? " " : "";
  const text = `${draft.slice(0, from)}${lead}${token}${tail}${draft.slice(to)}`;
  return { draft: text, cursor: from + lead.length + token.length, token };
}

/** Drop image tokens from the text the model reads. The image bytes are sent separately. */
export function stripImageTokens(text: string, images: ChatImage[]): string {
  if (!text.includes("[") || images.length === 0) return text;
  const spans = imageSpans(text, images);
  if (!spans.length) return text;
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start);
    cursor = span.end;
  }
  out += text.slice(cursor);
  return out.replace(/[^\S\n]{2,}/g, " ").replace(/[^\S\n]+$/gm, "").trim();
}

/**
 * The image chip a collapsed caret is deleting. Anywhere inside the token counts,
 * including the character just after `]`, so one backspace removes the whole name.
 * A selection still deletes normally.
 */
export function imageBeforeCursor(
  text: string,
  start: number,
  end: number,
  images: ChatImage[],
): ImageSpan | null {
  if (start !== end) return null;
  return imageSpans(text, images).find((span) => start > span.start && start <= span.end) ?? null;
}

export function removeImageSpan(text: string, span: ImageSpan): { text: string; cursor: number } {
  return { text: `${text.slice(0, span.start)}${text.slice(span.end)}`, cursor: span.start };
}

/** Remove one image's `[name]` tokens. Other text, including a hand-typed lookalike, stays. */
export function removeImageTokens(text: string, image: ChatImage): string {
  return imageSpans(text, [image]).reduceRight(
    (next, span) => `${next.slice(0, span.start)}${next.slice(span.end)}`,
    text,
  );
}

export function appendPromptImages(current: ChatImage[], extra: ChatImage[]): ChatImage[] {
  if (!extra.length) return current;
  return [...current, ...extra].slice(0, MAX_PROMPT_IMAGES);
}

export function imagesForChat(drafts: Record<string, ChatImage[]>, chatId: string): ChatImage[] {
  return drafts[chatId] ?? [];
}

export function setImagesForChat(
  drafts: Record<string, ChatImage[]>,
  chatId: string,
  images: ChatImage[],
): Record<string, ChatImage[]> {
  if (!images.length) {
    if (!(chatId in drafts)) return drafts;
    const next = { ...drafts };
    delete next[chatId];
    return next;
  }
  return { ...drafts, [chatId]: images };
}

export function persistableImages(images: ChatImage[]): ChatImage[] {
  return images.map(({ dataUrl: _dataUrl, ...img }) => img);
}

export function persistableCompaction(
  state: { summary: string; through: number } | null | undefined,
): { summary: string; through: number } | undefined {
  const summary = state?.summary.trim() ?? "";
  const through = Math.floor(state?.through ?? 0);
  if (!summary || through <= 0) return undefined;
  return { summary, through };
}

export function persistableMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((msg) =>
    msg.images?.length ? { ...msg, images: persistableImages(msg.images) } : msg,
  );
}

export async function withImageDataUrls(
  messages: ChatMessage[],
  load: (path: string) => Promise<string>,
  cache?: Map<string, string>,
): Promise<ChatMessage[]> {
  return Promise.all(
    messages.map(async (msg) => {
      if (!msg.images?.length) return msg;
      let changed = false;
      const images = await Promise.all(
        msg.images.map(async (img) => {
          if (img.dataUrl) return img;
          const cached = cache?.get(img.path);
          if (cached) {
            changed = true;
            return { ...img, dataUrl: cached };
          }
          const dataUrl = await load(img.path).catch(() => "");
          if (dataUrl && cache) cache.set(img.path, dataUrl);
          if (dataUrl) changed = true;
          return dataUrl ? { ...img, dataUrl } : img;
        }),
      );
      return changed ? { ...msg, images } : msg;
    }),
  );
}

export async function fileToBase64(file: Blob): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return btoa(binary);
}
