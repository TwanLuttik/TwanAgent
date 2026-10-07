import type { ChatImage, ChatMessage } from "./core.ts";

export type { ChatImage };

export const IMAGE_MAX_EDGE = 2048;
export const MAX_PROMPT_IMAGES = 8;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|jfif)$/i;
const REJECTED_IMAGE = /svg|heic|heif/;

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

export function isImageMime(value: string): boolean {
  const mime = mimeType(value);
  if (!mime.startsWith("image/") || REJECTED_IMAGE.test(mime)) return false;
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
