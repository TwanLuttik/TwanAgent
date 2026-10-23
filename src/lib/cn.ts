/** Join class names, dropping empties. Enough for the chart wrapper. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
