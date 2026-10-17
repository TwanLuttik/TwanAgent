import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

/** Soft-wrap long lines inside the editor instead of scrolling sideways. */
export function editorLineWrapping(): Extension {
  return EditorView.lineWrapping;
}

const LIGHT = {
  comment: "#6e6e73",
  keyword: "#9b2393",
  string: "#c41a16",
  number: "#1c00cf",
  func: "#326d74",
  type: "#0b4f79",
  tag: "#2a6f3f",
  attr: "#815f03",
  punct: "#6e6e73",
};

const DARK = {
  comment: "#8e8e93",
  keyword: "#ff7ab2",
  string: "#ff8170",
  number: "#d0bf69",
  func: "#6bdfff",
  type: "#dabaff",
  tag: "#acd7b7",
  attr: "#d0a8ff",
  punct: "#98989d",
};

export function editorTheme(mode: "light" | "dark"): Extension {
  const c = mode === "dark" ? DARK : LIGHT;
  const highlight = HighlightStyle.define([
    { tag: t.comment, color: c.comment, fontStyle: "italic" },
    { tag: t.lineComment, color: c.comment, fontStyle: "italic" },
    { tag: t.blockComment, color: c.comment, fontStyle: "italic" },
    { tag: t.keyword, color: c.keyword },
    { tag: t.controlKeyword, color: c.keyword },
    { tag: t.definitionKeyword, color: c.keyword },
    { tag: t.moduleKeyword, color: c.keyword },
    { tag: t.operatorKeyword, color: c.keyword },
    { tag: t.self, color: c.keyword },
    { tag: t.bool, color: c.keyword },
    { tag: t.null, color: c.keyword },
    { tag: t.string, color: c.string },
    { tag: t.special(t.string), color: c.string },
    { tag: t.number, color: c.number },
    { tag: t.integer, color: c.number },
    { tag: t.float, color: c.number },
    { tag: t.function(t.variableName), color: c.func },
    { tag: t.function(t.propertyName), color: c.func },
    { tag: t.definition(t.variableName), color: c.func },
    { tag: t.typeName, color: c.type },
    { tag: t.className, color: c.type },
    { tag: t.namespace, color: c.type },
    { tag: t.tagName, color: c.tag },
    { tag: t.angleBracket, color: c.punct },
    { tag: t.attributeName, color: c.attr },
    { tag: t.propertyName, color: c.attr },
    { tag: t.heading, color: c.keyword, fontWeight: "600" },
    { tag: t.link, color: c.func },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strong, fontWeight: "600" },
    { tag: t.meta, color: c.punct },
    { tag: t.processingInstruction, color: c.punct },
  ]);

  const chrome = EditorView.theme(
    {
      "&": {
        backgroundColor: "var(--color-canvas)",
        color: "var(--color-ink)",
        height: "100%",
      },
      "&.cm-editor": { height: "100%" },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        fontSize: "12px",
        lineHeight: "18px",
        overflow: "auto",
        overscrollBehavior: "contain",
      },
      ".cm-content": {
        caretColor: "var(--color-ink)",
        padding: "8px 0",
      },
      ".cm-gutters": {
        backgroundColor: "var(--color-panel)",
        color: "var(--color-muted)",
        borderRight: "1px solid var(--color-line)",
      },
      ".cm-gitGutter": {
        backgroundColor: "var(--color-panel)",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        minWidth: "2.4rem",
        padding: "0 8px 0 6px",
      },
      ".cm-activeLine": { backgroundColor: "var(--color-wash)" },
      ".cm-activeLineGutter": { backgroundColor: "var(--color-wash)", color: "var(--color-ink)" },
      ".cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
        backgroundColor: "var(--color-select) !important",
      },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-ink)" },
      ".cm-matchingBracket": { backgroundColor: "var(--color-inset)" },
    },
    { dark: mode === "dark" },
  );

  return [chrome, syntaxHighlighting(highlight)];
}
