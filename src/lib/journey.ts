import type { ChatMessage } from "./core.ts";
import type { ConversationSummary } from "./tauri.ts";

export type JourneyColor = "" | "blue" | "green" | "amber" | "rose" | "violet";

export const JOURNEY_COLORS: { id: JourneyColor; label: string; swatch: string; wash?: string }[] = [
  { id: "", label: "None", swatch: "transparent" },
  { id: "blue", label: "Blue", swatch: "#007aff", wash: "rgb(0 122 255 / 0.10)" },
  { id: "green", label: "Green", swatch: "#34c759", wash: "rgb(52 199 89 / 0.10)" },
  { id: "amber", label: "Amber", swatch: "#ff9f0a", wash: "rgb(255 159 10 / 0.10)" },
  { id: "rose", label: "Rose", swatch: "#ff375f", wash: "rgb(255 55 95 / 0.09)" },
  { id: "violet", label: "Violet", swatch: "#af52de", wash: "rgb(175 82 222 / 0.10)" },
];

export type JourneySummary = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  sort_order: number;
  collapsed: boolean;
  color?: string;
};

export function parseJourneyColor(raw: unknown): JourneyColor {
  if (raw === "blue" || raw === "green" || raw === "amber" || raw === "rose" || raw === "violet") {
    return raw;
  }
  return "";
}

export function journeyWash(raw: unknown): string | undefined {
  const id = parseJourneyColor(raw);
  return JOURNEY_COLORS.find((item) => item.id === id)?.wash;
}

export type SidebarNode =
  | { kind: "journey"; journey: JourneySummary; children: ConversationSummary[] }
  | { kind: "chat"; conversation: ConversationSummary };

export const JOURNEY_SUMMARIZE_PROMPT =
  "Summarize this conversation into bullet points the rest of this Journey can reuse. Cover decisions, facts, and open threads. Do not add a preamble.";

export function journeyKnowledgePath(id: string): string {
  return `journey:${id}`;
}

export function parseJourneyId(path: string): string | null {
  return path.startsWith("journey:") ? path.slice("journey:".length) : null;
}

export function isJourneyPath(path: string): boolean {
  return parseJourneyId(path) != null;
}

function sortKey(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function buildSidebar(
  conversations: ConversationSummary[],
  journeys: JourneySummary[],
): SidebarNode[] {
  const children = new Map<string, ConversationSummary[]>();
  const top: ConversationSummary[] = [];
  for (const row of conversations) {
    const journeyId = row.journey_id;
    if (journeyId) {
      const list = children.get(journeyId) ?? [];
      list.push(row);
      children.set(journeyId, list);
    } else {
      top.push(row);
    }
  }
  for (const list of children.values()) {
    list.sort((a, b) => sortKey(a.sort_order) - sortKey(b.sort_order) || a.id.localeCompare(b.id));
  }

  type Mixed = { sort: number; id: string; node: SidebarNode };
  const mixed: Mixed[] = [];
  for (const journey of journeys) {
    mixed.push({
      sort: sortKey(journey.sort_order),
      id: journey.id,
      node: {
        kind: "journey",
        journey,
        children: children.get(journey.id) ?? [],
      },
    });
  }
  for (const conversation of top) {
    mixed.push({
      sort: sortKey(conversation.sort_order),
      id: conversation.id,
      node: { kind: "chat", conversation },
    });
  }
  mixed.sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
  return mixed.map((row) => row.node);
}

export function conversationHasSummarizeSource(
  messages: { role?: string; content?: string | null }[],
): boolean {
  return messages.some((msg) => {
    if (msg.role !== "user" && msg.role !== "assistant") return false;
    return Boolean((msg.content ?? "").trim());
  });
}

export function lastAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && (msg.content ?? "").trim()) {
      return String(msg.content).trim();
    }
  }
  return "";
}

export function journeyKnowledgeBlock(knowledge: string): string {
  const text = knowledge.trim();
  if (!text) return "";
  return `Journey knowledge:\n${text}`;
}
