export function openChatTab(tabs: string[], id: string): string[] {
  const next = id.trim();
  if (!next || tabs.includes(next)) return tabs;
  return [...tabs, next];
}

export function closeChatTab(tabs: string[], id: string): { tabs: string[]; next: string | null } {
  const index = tabs.indexOf(id);
  if (index < 0) return { tabs, next: null };
  const remaining = tabs.filter((tab) => tab !== id);
  return { tabs: remaining, next: remaining[index] ?? remaining[index - 1] ?? null };
}
