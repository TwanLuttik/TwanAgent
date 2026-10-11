export type DiffLineKind = "meta" | "hunk" | "context" | "add" | "del";

export type DiffLine = {
  kind: DiffLineKind;
  text: string;
  oldNo?: number;
  newNo?: number;
};

export type DiffSection = {
  label?: "staged" | "unstaged";
  lines: DiffLine[];
};

const SECTION_RE = /^# (staged|unstaged)\s*$/;
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseGitDiff(raw: string): DiffSection[] {
  const text = raw.replace(/\r\n/g, "\n").replace(/\0/g, "\n");
  if (!text.trim()) return [];

  const sections: DiffSection[] = [];
  let current: DiffSection = { lines: [] };
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  const flush = () => {
    if (current.lines.length || current.label) sections.push(current);
    current = { lines: [] };
    inHunk = false;
  };

  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  for (const line of lines) {
    const section = line.match(SECTION_RE);
    if (section) {
      flush();
      current = { label: section[1] as "staged" | "unstaged", lines: [] };
      continue;
    }
    const hunk = line.match(HUNK_RE);
    if (hunk) {
      inHunk = true;
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      current.lines.push({ kind: "hunk", text: line });
      continue;
    }
    if (inHunk && (line === "\\ No newline at end of file" || line.startsWith("\\"))) {
      current.lines.push({ kind: "meta", text: line });
      continue;
    }
    if (inHunk && (line.startsWith("+") || line === "+") && !line.startsWith("+++")) {
      current.lines.push({ kind: "add", text: line.slice(1), newNo });
      newNo += 1;
      continue;
    }
    if (inHunk && (line.startsWith("-") || line === "-") && !line.startsWith("---")) {
      current.lines.push({ kind: "del", text: line.slice(1), oldNo });
      oldNo += 1;
      continue;
    }
    if (inHunk && (line.startsWith(" ") || line === "")) {
      current.lines.push({ kind: "context", text: line.startsWith(" ") ? line.slice(1) : line, oldNo, newNo });
      oldNo += 1;
      newNo += 1;
      continue;
    }
    current.lines.push({ kind: "meta", text: line });
  }

  flush();
  return sections.filter((section) => section.lines.length > 0 || section.label);
}

export type DiffFile = {
  path: string;
  original?: string;
  label?: DiffSection["label"];
  lines: DiffLine[];
};

const GIT_FILE_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const PLUSPLUS_RE = /^\+\+\+ (?:b\/)?(.+)$/;
const MINUSMINUS_RE = /^--- (?:a\/)?(.+)$/;

export function groupDiffByFile(sections: DiffSection[]): DiffFile[] {
  const files: DiffFile[] = [];
  for (const section of sections) {
    let current: DiffFile | null = null;
    for (const line of section.lines) {
      if (line.kind === "meta") {
        const git = line.text.match(GIT_FILE_RE);
        if (git) {
          const from = gitPath(git[1]);
          const to = gitPath(git[2]);
          const next = to === "/dev/null" ? from : to;
          current = {
            path: next,
            original: from !== next && from !== "/dev/null" ? from : undefined,
            label: section.label,
            lines: [line],
          };
          files.push(current);
          continue;
        }
        const plus = line.text.match(PLUSPLUS_RE);
        if (plus && current) {
          const path = gitPath(plus[1]);
          if (path !== "/dev/null") current.path = path;
        }
        const minus = line.text.match(MINUSMINUS_RE);
        if (minus && current) {
          const path = gitPath(minus[1]);
          if (path !== "/dev/null" && path !== current.path) current.original = path;
        }
      }
      if (!current) {
        current = { path: "", label: section.label, lines: [] };
        files.push(current);
      }
      if (line.kind === "meta" && GIT_FILE_RE.test(line.text)) continue;
      current.lines.push(line);
    }
  }
  return files.filter((file) => file.lines.length > 0);
}

function gitPath(raw: string): string {
  const text = raw.trim().replace(/^"(.*)"$/, "$1");
  return text === "/dev/null" ? text : text.replace(/\\/g, "/");
}

export type GutterMark = "add" | "del" | "mod";

const MARK_RANK: Record<GutterMark, number> = { del: 1, add: 2, mod: 3 };

function markDeletion(
  lines: DiffLine[],
  index: number,
  set: (line: number | undefined, kind: GutterMark) => void,
) {
  const next = lines[index];
  if (next?.newNo) {
    set(next.newNo, "del");
    return;
  }
  for (let j = index - 1; j >= 0; j--) {
    if (lines[j].newNo) {
      set(lines[j].newNo, "del");
      return;
    }
  }
}

export function gutterMarksFromDiff(sections: DiffSection[]): Map<number, GutterMark> {
  const marks = new Map<number, GutterMark>();
  const set = (line: number | undefined, kind: GutterMark) => {
    if (!line || line < 1) return;
    const prev = marks.get(line);
    if (!prev || MARK_RANK[kind] > MARK_RANK[prev]) marks.set(line, kind);
  };

  for (const section of sections) {
    const lines = section.lines;
    let i = 0;
    while (i < lines.length) {
      if (lines[i].kind !== "del" && lines[i].kind !== "add") {
        i += 1;
        continue;
      }
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (i < lines.length && lines[i].kind === "del") {
        dels.push(lines[i]);
        i += 1;
      }
      while (i < lines.length && lines[i].kind === "add") {
        adds.push(lines[i]);
        i += 1;
      }
      if (adds.length && dels.length) {
        const shared = Math.min(adds.length, dels.length);
        adds.forEach((add, idx) => set(add.newNo, idx < shared ? "mod" : "add"));
        if (dels.length > adds.length) markDeletion(lines, i, set);
      } else if (adds.length) {
        for (const add of adds) set(add.newNo, "add");
      } else {
        markDeletion(lines, i, set);
      }
    }
  }
  return marks;
}

export function deletedFileDiff(path: string, contents: string): string {
  const lines = contents.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const count = Math.max(lines.length, 1);
  const body = (lines.length ? lines : [""]).map((line) => `-${line}`).join("\n");
  const clean = path.replace(/\\/g, "/");
  return `diff --git a/${clean} b/${clean}\n--- a/${clean}\n+++ /dev/null\n@@ -1,${count} +0,0 @@\n${body}\n`;
}

export function addedFileDiff(path: string, contents: string): string {
  const lines = contents.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const count = Math.max(lines.length, 1);
  const body = (lines.length ? lines : [""]).map((line) => `+${line}`).join("\n");
  return `diff --git a/${path.replace(/\\/g, "/")} b/${path.replace(/\\/g, "/")}\n--- /dev/null\n+++ b/${path.replace(/\\/g, "/")}\n@@ -0,0 +1,${count} @@\n${body}\n`;
}
