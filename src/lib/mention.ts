import { HEAVY_DIRS } from "./core.ts";
import { fileBaseName } from "./file-icon.ts";

export type MentionFile = { path: string; name: string };

export type MentionQuery = { start: number; end: number; query: string };

const MENTION = /(?:^|[\s([{])@([^\s@]*)$/;

/** The `@query` sitting at the caret, if the user is mentioning a file. */
export function mentionAtCursor(text: string, cursor: number): MentionQuery | null {
  const head = text.slice(0, Math.max(0, cursor));
  const match = MENTION.exec(head);
  if (!match || match.index == null) return null;
  const token = match[1] ?? "";
  const at = head.lastIndexOf("@");
  if (at < 0) return null;
  return { start: at, end: cursor, query: token };
}

export function filterMentionFiles(files: MentionFile[], query: string, limit = 8): MentionFile[] {
  const q = query.trim().toLowerCase();
  const ranked: { file: MentionFile; score: number }[] = [];
  for (const file of files) {
    const score = mentionScore(file, q);
    if (score <= 0) continue;
    const row = { file, score };
    const at = ranked.findIndex(
      (item) =>
        row.score > item.score ||
        (row.score === item.score &&
          (row.file.path.length < item.file.path.length ||
            (row.file.path.length === item.file.path.length &&
              row.file.path.localeCompare(item.file.path) < 0))),
    );
    if (at === -1) {
      if (ranked.length < limit) ranked.push(row);
      continue;
    }
    ranked.splice(at, 0, row);
    if (ranked.length > limit) ranked.pop();
  }
  return ranked.map((row) => row.file);
}

function mentionScore(file: MentionFile, query: string): number {
  if (!query) return 1;
  const name = file.name.toLowerCase();
  const path = file.path.toLowerCase();
  if (name === query) return 100;
  if (name.startsWith(query)) return 80;
  if (path.endsWith(`/${query}`)) return 70;
  if (name.includes(query)) return 50;
  if (path.includes(query)) return 30;
  return 0;
}

export type MentionSpan = { start: number; end: number; file: MentionFile };

/** Ranges of `@name` tokens that match a known file, so the composer can color them. */
export function draftMentionSpans(text: string, files: MentionFile[]): MentionSpan[] {
  if (!text.includes("@") || files.length === 0) return [];
  const byName = new Map<string, MentionFile>();
  for (const file of files) {
    const key = file.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, file);
  }
  const spans: MentionSpan[] = [];
  const re = /(^|[\s([{])@([^\s@]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const lead = match[1] ?? "";
    const token = match[2] ?? "";
    const file = byName.get(token.toLowerCase());
    if (!file) continue;
    const start = match.index + lead.length;
    spans.push({ start, end: start + token.length + 1, file });
  }
  return spans;
}

const MENTION_LEAD = String.raw`(?:^|[\s([{])`;

/**
 * Show a sent file mention as `@name`. The stored prompt keeps the workspace path
 * so the model still sees it; only paths from the mention list are folded.
 */
export function displayFileMentions(text: string, files: MentionFile[]): string {
  if (!text || !files.length) return text;
  const paths = [...files]
    .map((file) => ({
      path: file.path.replace(/\\/g, "/"),
      name: file.name || fileBaseName(file.path),
    }))
    .filter((file) => file.path.includes("/") && file.name)
    .sort((a, b) => b.path.length - a.path.length);
  if (!paths.length) return text;
  const byPath = new Map<string, string>();
  for (const file of paths) {
    if (!byPath.has(file.path)) byPath.set(file.path, file.name);
  }
  const pattern = paths.map((file) => file.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`(${MENTION_LEAD})(${pattern})(?=$|[\\s)\\]}.,;:!?])`, "g");
  return text.replace(re, (full, lead: string, path: string) => {
    const name = byPath.get(path);
    return name ? `${lead}@${name}` : full;
  });
}

/** Replace each picked `@name` with that file's workspace path. Unpicked mentions stay. */
export function expandFileMentions(text: string, mentions: MentionFile[]): string {
  if (!mentions.length || !text.includes("@")) return text;
  const byName = new Map<string, MentionFile[]>();
  for (const file of mentions) {
    const key = file.name.toLowerCase();
    const rows = byName.get(key) ?? [];
    rows.push(file);
    byName.set(key, rows);
  }
  return text.replace(/(^|[\s([{])@([^\s@]+)/g, (full, lead: string, token: string) => {
    const rows = byName.get(token.toLowerCase());
    if (!rows?.length) return full;
    const picked =
      rows.find((file) => file.name === token) ??
      rows.find((file) => fileBaseName(file.path).toLowerCase() === token.toLowerCase()) ??
      rows[0];
    return `${lead}${picked.path}`;
  });
}

export function applyMention(
  text: string,
  mention: MentionQuery,
  file: MentionFile,
): { text: string; cursor: number } {
  const next = `${text.slice(0, mention.start)}@${file.name} ${text.slice(mention.end)}`;
  const cursor = mention.start + file.name.length + 2;
  return { text: next, cursor };
}

type DirEntry = { name: string; path: string; kind: string };

/** Walk the workspace and collect files, skipping heavy folders. */
export async function collectWorkspaceFiles(
  listDir: (path: string) => Promise<DirEntry[]>,
  cap = 4000,
): Promise<MentionFile[]> {
  const files: MentionFile[] = [];
  const queue = [""];
  const seen = new Set<string>();
  while (queue.length && files.length < cap) {
    const dir = queue.shift() ?? "";
    if (seen.has(dir)) continue;
    seen.add(dir);
    let rows: DirEntry[] = [];
    try {
      rows = await listDir(dir);
    } catch {
      continue;
    }
    for (const row of rows) {
      if (HEAVY_DIRS.has(row.name) || row.name === ".git") continue;
      if (row.kind === "dir") {
        queue.push(row.path);
        continue;
      }
      files.push({ path: row.path.replace(/\\/g, "/"), name: row.name || fileBaseName(row.path) });
      if (files.length >= cap) break;
    }
  }
  return files;
}
