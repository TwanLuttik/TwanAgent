export const PASTE_MIN = 200;
export const PASTE_LABEL = "#pasted";

export type PasteBlock = { id: string; text: string };

const TOKEN = /(?:^|[\s([{])#pasted-([a-z0-9]+)/gi;

export function shouldCollapsePaste(text: string): boolean {
  return text.length > PASTE_MIN;
}

export function pasteToken(id: string): string {
  return `${PASTE_LABEL}-${id}`;
}

export function newPasteId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Swap a long clipboard paste for a short token. Short text is inserted as-is. */
export function insertCollapsedPaste(
  draft: string,
  start: number,
  end: number,
  pasted: string,
  id = newPasteId(),
): { draft: string; cursor: number; paste: PasteBlock | null } {
  const from = Math.max(0, Math.min(start, end, draft.length));
  const to = Math.max(0, Math.min(Math.max(start, end), draft.length));
  if (!shouldCollapsePaste(pasted)) {
    const text = `${draft.slice(0, from)}${pasted}${draft.slice(to)}`;
    return { draft: text, cursor: from + pasted.length, paste: null };
  }
  const token = pasteToken(id);
  const lead = from > 0 && !/\s$/.test(draft.slice(0, from)) ? " " : "";
  const tail = to < draft.length && !/^\s/.test(draft.slice(to)) ? " " : "";
  const text = `${draft.slice(0, from)}${lead}${token}${tail}${draft.slice(to)}`;
  return { draft: text, cursor: from + lead.length + token.length + tail.length, paste: { id, text: pasted } };
}

export type PasteSpan = { start: number; end: number; id: string };

export function pasteSpans(text: string, pastes: PasteBlock[]): PasteSpan[] {
  if (!text.includes("#") || pastes.length === 0) return [];
  const known = new Set(pastes.map((paste) => paste.id));
  const spans: PasteSpan[] = [];
  const re = new RegExp(TOKEN.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const id = match[1] ?? "";
    if (!known.has(id)) continue;
    const token = pasteToken(id);
    const start = match.index + match[0].length - token.length;
    spans.push({ start, end: start + token.length, id });
  }
  return spans;
}

/** Put the hidden paste back where its token sits. Unknown tokens stay. */
export function expandPasteTokens(text: string, pastes: PasteBlock[]): string {
  if (!text.includes("#") || pastes.length === 0) return text;
  const byId = new Map(pastes.map((paste) => [paste.id, paste.text]));
  return text.replace(new RegExp(TOKEN.source, "gi"), (full, id: string) => {
    const body = byId.get(id);
    if (body == null) return full;
    const token = pasteToken(id);
    const lead = full.slice(0, full.length - token.length);
    return `${lead}${body}`;
  });
}

export function flattenPasteToken(text: string, paste: PasteBlock): string {
  const token = pasteToken(paste.id);
  const at = text.indexOf(token);
  if (at < 0) return text;
  return `${text.slice(0, at)}${paste.text}${text.slice(at + token.length)}`;
}

/**
 * The chip sitting just before the caret. Only a collapsed cursor counts,
 * so a selection still deletes normally.
 */
export function pasteBeforeCursor(
  text: string,
  start: number,
  end: number,
  pastes: PasteBlock[],
): PasteSpan | null {
  if (start !== end) return null;
  return pasteSpans(text, pastes).find((span) => span.end === start) ?? null;
}

export function removePasteSpan(text: string, span: PasteSpan): { text: string; cursor: number } {
  return { text: `${text.slice(0, span.start)}${text.slice(span.end)}`, cursor: span.start };
}

export function replacePasteToken(text: string, paste: PasteBlock, next: string): string {
  const token = pasteToken(paste.id);
  const at = text.indexOf(token);
  if (at < 0) return text;
  return `${text.slice(0, at)}${next}${text.slice(at + token.length)}`;
}
