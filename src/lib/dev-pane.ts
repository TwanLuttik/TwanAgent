export type PaneKind = "terminal" | "files" | "git";

export type PaneTab = {
  id: string;
  kind: PaneKind;
  title: string;
};

export type PaneState = {
  tabs: PaneTab[];
  activeId: string;
};

export const PANE_KINDS: { id: PaneKind; label: string; icon: string }[] = [
  { id: "terminal", label: "Terminal", icon: "terminal" },
  { id: "files", label: "Files", icon: "folder" },
  { id: "git", label: "Git", icon: "arrow.triangle.branch" },
];

export function paneMeta(kind: PaneKind) {
  return PANE_KINDS.find((k) => k.id === kind) ?? PANE_KINDS[0];
}

export function defaultPaneState(): PaneState {
  const tabs: PaneTab[] = [
    { id: newTabId("terminal"), kind: "terminal", title: "Terminal" },
    { id: "files", kind: "files", title: "Files" },
    { id: "git", kind: "git", title: "Git" },
  ];
  return { tabs, activeId: "files" };
}

export function addableKinds(tabs: PaneTab[]): PaneKind[] {
  const kinds: PaneKind[] = ["terminal"];
  if (!tabs.some((t) => t.kind === "files")) kinds.push("files");
  if (!tabs.some((t) => t.kind === "git")) kinds.push("git");
  return kinds;
}

export function nextTerminalTitle(tabs: PaneTab[]): string {
  let max = 0;
  for (const tab of tabs) {
    if (tab.kind !== "terminal") continue;
    max = Math.max(max, terminalNumber(tab.title));
  }
  const next = max + 1;
  return next <= 1 ? "Terminal" : `Terminal ${next}`;
}

export function openPane(state: PaneState, kind: PaneKind): PaneState {
  if (kind !== "terminal") {
    const existing = state.tabs.find((t) => t.kind === kind);
    if (existing) return { ...state, activeId: existing.id };
  }
  const tab: PaneTab = {
    id: kind === "terminal" ? newTabId("terminal") : kind,
    kind,
    title: kind === "terminal" ? nextTerminalTitle(state.tabs) : paneMeta(kind).label,
  };
  return { tabs: [...state.tabs, tab], activeId: tab.id };
}

export function closePane(state: PaneState, id: string): PaneState {
  if (state.tabs.length <= 1) return state;
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return state;
  const tabs = state.tabs.filter((t) => t.id !== id);
  if (state.activeId !== id) return { tabs, activeId: state.activeId };
  const neighbor = tabs[idx] ?? tabs[idx - 1];
  return { tabs, activeId: neighbor.id };
}

export function selectPane(state: PaneState, id: string): PaneState {
  if (!state.tabs.some((t) => t.id === id)) return state;
  return { ...state, activeId: id };
}

function terminalNumber(title: string): number {
  if (title === "Terminal") return 1;
  const match = /^Terminal (\d+)$/.exec(title);
  return match ? Number(match[1]) : 1;
}

function newTabId(kind: PaneKind): string {
  return `${kind}-${crypto.randomUUID()}`;
}
