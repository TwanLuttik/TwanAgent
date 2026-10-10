export type LineDiffPart = { text: string; changed: boolean };

export type LineDiffRow =
  | { kind: "same"; text: string }
  | { kind: "del"; text: string }
  | { kind: "add"; text: string }
  | { kind: "change"; removed: LineDiffPart[]; added: LineDiffPart[] };

/** Keep a filename such as dev.ts together, and split the rest on punctuation. */
const WORD = /[\w.]+|\s+|./g;

/** Compact peek: changed lines only, unchanged context dropped. */
export function compactDiffRows(removed: string[], added: string[], limit = 8): LineDiffRow[] {
  const changed = lineDiffRows(removed, added).filter((row) => row.kind !== "same");
  return changed.slice(0, limit);
}

/** Pair removed and added lines so a one-line edit shows as one highlighted row. */
export function lineDiffRows(removed: string[], added: string[]): LineDiffRow[] {
  const rows: LineDiffRow[] = [];
  const shared = Math.min(removed.length, added.length);
  for (let i = 0; i < shared; i++) {
    const before = removed[i] ?? "";
    const after = added[i] ?? "";
    if (before === after) rows.push({ kind: "same", text: before });
    else rows.push({ kind: "change", removed: wordDiff(before, after), added: wordDiff(after, before) });
  }
  for (let i = shared; i < removed.length; i++) rows.push({ kind: "del", text: removed[i] ?? "" });
  for (let i = shared; i < added.length; i++) rows.push({ kind: "add", text: added[i] ?? "" });
  return rows;
}

function wordDiff(source: string, other: string): LineDiffPart[] {
  const left = tokens(source);
  const right = tokens(other);
  const shared = lcs(left, right);
  const parts: LineDiffPart[] = [];
  let at = 0;
  for (const word of left) {
    const changed = at >= shared.length || word !== shared[at];
    if (!changed) at += 1;
    const last = parts[parts.length - 1];
    if (last && last.changed === changed) last.text += word;
    else parts.push({ text: word, changed });
  }
  return parts;
}

function tokens(text: string): string[] {
  return text.match(WORD) ?? (text ? [text] : []);
}

/** Tokens that appear in both lines, in order. */
function lcs(left: string[], right: string[]): string[] {
  const rows = left.length;
  const cols = right.length;
  const dp: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (left[i] === right[j]) {
      out.push(left[i]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i += 1;
    else j += 1;
  }
  return out;
}
