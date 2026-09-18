import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, gutter } from "@codemirror/view";
import type { GutterMark } from "./dev-git-diff";

class GitChangeMarker extends GutterMarker {
  constructor(readonly kind: GutterMark) {
    super();
  }

  eq(other: GitChangeMarker) {
    return other.kind === this.kind;
  }

  toDOM() {
    const el = document.createElement("span");
    el.className = `cm-gitMark cm-gitMark-${this.kind}`;
    el.title = this.kind === "del" ? "Deleted lines" : this.kind === "mod" ? "Modified" : "Added";
    return el;
  }
}

export function gitChangeGutter(marks: Map<number, GutterMark>): Extension {
  return [
    gutter({
      class: "cm-gitGutter",
      renderEmptyElements: false,
      markers(view) {
        const builder = new RangeSetBuilder<GutterMarker>();
        const lines = [...marks.keys()].sort((a, b) => a - b);
        for (const line of lines) {
          if (line < 1 || line > view.state.doc.lines) continue;
          const kind = marks.get(line);
          if (!kind) continue;
          const pos = view.state.doc.line(line).from;
          builder.add(pos, pos, new GitChangeMarker(kind));
        }
        return builder.finish();
      },
    }),
    EditorView.baseTheme({
      ".cm-gitGutter": {
        width: "4px",
        minWidth: "4px",
      },
      ".cm-gitGutter .cm-gutterElement": {
        padding: "0",
      },
      ".cm-gitMark": {
        display: "block",
        width: "3px",
        height: "100%",
        marginLeft: "1px",
        borderRadius: "1px",
      },
      ".cm-gitMark-add, .cm-gitMark-mod": {
        backgroundColor: "var(--color-ok)",
      },
      ".cm-gitMark-del": {
        backgroundColor: "var(--color-err)",
      },
    }),
  ];
}
