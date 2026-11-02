import type { Entry } from "../../lib/tauri";

export function fileNodeMap(childrenOf: Record<string, Entry[]>): Map<string, Entry> {
  const map = new Map<string, Entry>();
  for (const rows of Object.values(childrenOf)) {
    for (const row of rows) map.set(row.path, row);
  }
  return map;
}
