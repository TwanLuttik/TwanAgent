export type TextPosition = { line: number; col: number };

export type SelectionRange = {
  path: string;
  fromLine: number;
  fromCol: number;
  toLine: number;
  toCol: number;
  text: string;
};

export function positionAt(text: string, offset: number): TextPosition {
  const pos = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let start = 0;
  for (let i = 0; i < pos; i++) {
    if (text[i] === "\n") {
      line += 1;
      start = i + 1;
    }
  }
  return { line, col: pos - start + 1 };
}

export function selectionRangeFromOffsets(
  path: string,
  text: string,
  from: number,
  to: number,
): SelectionRange {
  const start = Math.max(0, Math.min(from, to));
  const end = Math.max(0, Math.max(from, to));
  const a = positionAt(text, start);
  const b = positionAt(text, end);
  return {
    path,
    fromLine: a.line,
    fromCol: a.col,
    toLine: b.line,
    toCol: b.col,
    text: text.slice(start, end),
  };
}

export function selectionCite(range: SelectionRange): string {
  return `${range.path}:${range.fromLine}:${range.fromCol}-${range.toLine}:${range.toCol}`;
}

export function selectionPromptSnippet(range: SelectionRange): string {
  const body = range.text.replace(/\n$/, "");
  return `${selectionCite(range)}\n\n\`\`\`\n${body}\n\`\`\``;
}

export function appendSelectionToDraft(draft: string, snippet: string): string {
  const base = draft.trim();
  return base ? `${base}\n\n${snippet}` : snippet;
}
